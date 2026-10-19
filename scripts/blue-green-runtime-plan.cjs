/*
 * Read-only discovery for the two CERP blue/green front doors.
 * It deliberately has no apply, reload, container, or service subcommand.
 */
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

if (process.argv.length !== 3 || process.argv[2] !== "--planRO") {
  throw new Error("Usage: node scripts/blue-green-runtime-plan.cjs --planRO");
}

const vpsSsh = [
  "-i", "C:/Users/KeenanMARTIN/.ssh/id_ed25519_codex_cerp_vps",
  "-o", "BatchMode=yes", "-o", "ConnectTimeout=8",
  "root@82.25.112.61", "python3 -",
];
const hyperSsh = [
  "-i", "C:/Users/KeenanMARTIN/.ssh/id_ed25519_cerp_atelier",
  "-o", "BatchMode=yes", "-o", "ConnectTimeout=8",
  "-o", "HostKeyAlias=192.168.1.244",
  "-o", "ProxyCommand=ssh -i C:/Users/KeenanMARTIN/.ssh/id_ed25519_codex_cerp_vps -o BatchMode=yes -o ConnectTimeout=8 -W %h:%p root@82.25.112.61",
  "keenan@10.90.0.2", "sudo -n python3 -",
];

function readOnlySsh(args, python, name) {
  const result = spawnSync("ssh.exe", args, {
    input: python,
    encoding: "utf8",
    windowsHide: true,
    timeout: 25_000,
    maxBuffer: 1_000_000,
  });
  if (result.status !== 0) throw new Error(`${name} read-only collection failed: ${String(result.stderr || result.error || result.stdout).slice(-600)}`);
  return JSON.parse(result.stdout);
}

const vpsPython = String.raw`import hashlib,json,pathlib,re,subprocess
p=pathlib.Path('/data/coolify/proxy/dynamic/cerp-web-same-origin-routing.yaml')
assert p.is_file() and not p.is_symlink()
t=p.read_text()
routers={}; current=None; in_services=False
for line in t.splitlines():
 if re.match(r'^\s*services:\s*$',line): in_services=True
 if not in_services:
  m=re.match(r'^    ([^:#][^:]*):\s*$',line)
  if m: current=m.group(1)
  m=re.match(r'^      (rule|service):\s*(.+?)\s*$',line)
  if m and current: routers.setdefault(current,{})[m.group(1)]=m.group(2).strip("'\\\"")
service='https-0-rcccokw0wgcw0ck44g0wk0ck@docker'
image_name=service.removesuffix('@docker').removeprefix('https-0-')
names=[n for n,v in routers.items() if v.get('service')==service]
assert names, 'expected CERP routed service is absent'
ids=subprocess.check_output(['docker','ps','-q'],text=True).split()
raw=json.loads(subprocess.check_output(['docker','inspect',*ids],text=True)) if ids else []
allowed=('traefik.enable','org.opencontainers.image.revision')
dynamic=p.parent
def parse_dynamic(file):
 text=file.read_text()
 if file.name=='Caddyfile':
  blocks=[]; active=False; upstreams=[]
  for line in text.splitlines():
   if 'erp-backend.croix-rousse-precision.fr' in line: active=True; upstreams=[]
   if active:
    m=re.match(r'^\s*reverse_proxy\s+(\S+)',line)
    if m: upstreams.append(m.group(1))
    if line.strip()=='}': blocks.append({'host':'erp-backend.croix-rousse-precision.fr','upstreams':upstreams}); active=False
  return {'name':file.name,'sha256':hashlib.sha256(text.encode()).hexdigest(),'routers':{},'services':{},'caddy_routes':blocks}
 section=None; item=None; routers={}; services={}
 for line in text.splitlines():
  if re.match(r'^  routers:\s*$',line): section='routers'; item=None; continue
  if re.match(r'^  services:\s*$',line): section='services'; item=None; continue
  heading=re.match(r'^    ([^\s:#][^:]*):\s*$',line)
  if heading: item=heading.group(1); continue
  field=re.match(r'^      (rule|service|priority):\s*(.+?)\s*$',line)
  if field and item and section=='routers' and field.group(1) in ('rule','service','priority'): routers.setdefault(item,{})[field.group(1)]=field.group(2).strip("'\\\"")
  url=re.match(r'^\s*-\s*url:\s*(.+?)\s*$',line)
  if url and item and section=='services':
   from urllib.parse import urlsplit,urlunsplit
   raw=url.group(1).strip("'\\\""); u=urlsplit(raw)
   if u.scheme and u.hostname:
    host=u.hostname + ((':'+str(u.port)) if u.port else '')
    services.setdefault(item,[]).append(urlunsplit((u.scheme,host,u.path,'','')))
 wanted={n:v for n,v in routers.items() if 'erp-backend.croix-rousse-precision.fr' in v.get('rule','') or any(x in v.get('rule','').lower() for x in ('desktop-updates','ged','test'))}
 return {'name':file.name,'sha256':hashlib.sha256(text.encode()).hexdigest(),'routers':wanted,'services':{v['service']:services.get(v['service'],[]) for v in wanted.values() if v.get('service')},'caddy_routes':[]}
dynamic_files=[]; dynamic_routes=[]; caddy_routes=[]
for file in sorted(dynamic.iterdir(),key=lambda x:x.name):
 if file.is_file() and not file.is_symlink():
  parsed=parse_dynamic(file); dynamic_files.append({'name':parsed['name'],'sha256':parsed['sha256']})
  if parsed['routers']: dynamic_routes.append(parsed)
  if parsed['caddy_routes']: caddy_routes.append({'name':parsed['name'],'sha256':parsed['sha256'],'routes':parsed['caddy_routes']})
def all_router_labels(labels):
 rows={}
 for k,v in labels.items():
  prefix='traefik.http.routers.'
  if not k.startswith(prefix): continue
  suffix=k[len(prefix):]
  if '.' not in suffix: continue
  name,field=suffix.rsplit('.',1)
  if name and field in ('rule','priority','service'): rows.setdefault(name,{})[field]=v
 return rows
def relevant_router_labels(labels):
 rows=all_router_labels(labels)
 return {n:v for n,v in rows.items() if 'erp-backend.croix-rousse-precision.fr' in v.get('rule','') or any(x in v.get('rule','').lower() for x in ('desktop-updates','ged','test'))}
inventory=[]
docker_routes=[]
for c in raw:
 labels=c.get('Config',{}).get('Labels') or {}
 safe={k:labels[k] for k in allowed if k in labels}
 routes=relevant_router_labels(labels)
 host=c.get('HostConfig',{}) or {}
 if routes:
  docker_routes.append({'id':c.get('Id','')[:12],'image':c.get('Config',{}).get('Image'),'revision':labels.get('org.opencontainers.image.revision'),'caps':{'add':sorted(host.get('CapAdd') or []),'drop':sorted(host.get('CapDrop') or [])},'labels':safe,'networks':sorted((c.get('NetworkSettings',{}).get('Networks') or {}).keys()),'routers':routes})
 if c.get('Config',{}).get('Image','').split(':',1)[0]==image_name:
  inventory.append({'id':c.get('Id','')[:12],'image':c.get('Config',{}).get('Image'),'revision':labels.get('org.opencontainers.image.revision'),'caps':{'add':sorted(host.get('CapAdd') or []),'drop':sorted(host.get('CapDrop') or [])},'labels':safe,'networks':sorted((c.get('NetworkSettings',{}).get('Networks') or {}).keys()),'routers':all_router_labels(labels)})
proxy=[c for c in raw if c.get('Name','').lstrip('/')=='coolify-proxy']
proxy_inventory=[]; api_routes=[]; api_services=[]; api_status='not_configured'
for c in proxy:
 cfg=c.get('Config',{}) or {}; mounts=c.get('Mounts',[]) or {}
 args=[x for x in (cfg.get('Entrypoint') or [])+(cfg.get('Cmd') or []) if any(token in str(x).lower() for token in ('api','file','docker'))]
 safe_mounts=[{'source':m.get('Source'),'destination':m.get('Destination'),'type':m.get('Type')} for m in mounts if any(token in str(m.get('Destination','')).lower() for token in ('traefik','dynamic','proxy'))]
 proxy_inventory.append({'id':c.get('Id','')[:12],'image':cfg.get('Image'),'entrypoint_cmd_provider_args':args,'mounts':safe_mounts})
 def api(path):
  r=subprocess.run(['docker','exec',c['Id'],'wget','-qO-',path],text=True,capture_output=True,timeout=5)
  return json.loads(r.stdout) if r.returncode==0 and r.stdout else None
 routers_api=api('http://127.0.0.1:8080/api/http/routers')
 services_api=api('http://127.0.0.1:8080/api/http/services')
 if isinstance(routers_api,list):
  api_status='available'
  api_routes += [{'name':r.get('name'),'rule':r.get('rule'),'priority':r.get('priority'),'service':r.get('service'),'provider':r.get('provider')} for r in routers_api if 'erp-backend.croix-rousse-precision.fr' in str(r.get('rule','')) or any(x in str(r.get('rule','')).lower() for x in ('desktop-updates','ged','test'))]
 if isinstance(services_api,list):
  referenced={r.get('service') for r in api_routes}
  for s in services_api:
   if s.get('name') in referenced:
    servers=(s.get('loadBalancer') or {}).get('servers') or []
    api_services.append({'name':s.get('name'),'provider':s.get('provider'),'urls':[x.get('url') for x in servers if x.get('url')]})
 if routers_api is None: api_status='unavailable'
print(json.dumps({'host':'vps','read_only':True,'route_file':str(p),'route_sha256':hashlib.sha256(t.encode()).hexdigest(),'routes':{n:routers[n] for n in names},'inventory':inventory,'docker_routes':docker_routes,'dynamic_files':dynamic_files,'dynamic_routes':dynamic_routes,'caddy_routes':caddy_routes,'proxy':proxy_inventory,'internal_api':{'status':api_status,'routers':api_routes,'services':api_services}}))`;

const hyperPython = String.raw`import hashlib,json,pathlib,re,subprocess,shutil,pwd,grp
p=pathlib.Path('/etc/apache2/sites-enabled/cerp-local.conf')
# Debian's sites-enabled entries are conventionally symlinks.  Resolve only
# inside Apache's configuration tree; the report still identifies the enabled path.
config_target=p.resolve(strict=True)
assert p.is_file() and str(config_target).startswith('/etc/apache2/')
t=config_target.read_text()
routes=[]
for line in t.splitlines():
 m=re.match(r'^\s*(ProxyPass(?:Reverse)?)\s+(/(?:api|socket\.io)/)\s+(\S+)(.*)$',line,re.I)
 if m: routes.append({'directive':m.group(1),'path':m.group(2),'upstream':m.group(3),'options':m.group(4).strip()})
assert any(r['path']=='/api/' for r in routes) and any(r['path']=='/socket.io/' for r in routes)
enabled=pathlib.Path('/etc/apache2/sites-enabled')
vhosts=[]
for link in sorted(enabled.iterdir(),key=lambda x:x.name):
 vhost_target=link.resolve(strict=True)
 if not vhost_target.is_file() or not str(vhost_target).startswith('/etc/apache2/'): continue
 text=vhost_target.read_text(); stat=vhost_target.stat(); directives=[]
 for line in text.splitlines():
  m=re.match(r'^\s*(ProxyPass(?:Reverse)?)\s+(\S+)\s+(\S+)(.*)$',line,re.I)
  if m and ('8080' in m.group(3) or '8084' in m.group(3)): directives.append({'directive':m.group(1),'path':m.group(2),'upstream':m.group(3),'options':m.group(4).strip()})
 if directives: vhosts.append({'enabled_path':str(link),'resolved_path':str(vhost_target),'sha256':hashlib.sha256(text.encode()).hexdigest(),'owner':pwd.getpwuid(stat.st_uid).pw_name,'group':grp.getgrgid(stat.st_gid).gr_name,'mode':oct(stat.st_mode & 0o777),'directives':directives})
listener=subprocess.run(['ss','-ltnp','sport = :8084'],text=True,capture_output=True,timeout=5)
lines=[line for line in listener.stdout.splitlines() if ':8084' in line]
docker=shutil.which('docker')
ids=subprocess.check_output([docker,'ps','-q'],text=True).split() if docker else []
raw=json.loads(subprocess.check_output([docker,'inspect',*ids],text=True)) if ids else []
inventory=[]
for c in raw:
 labels=c.get('Config',{}).get('Labels') or {}
 revision=labels.get('org.opencontainers.image.revision')
 name=c.get('Name','').lstrip('/')
 if revision or 'cerp' in name.lower():
  host=c.get('HostConfig',{}) or {}
  inventory.append({'id':c.get('Id','')[:12],'image':c.get('Config',{}).get('Image'),'revision':revision,'caps':{'add':sorted(host.get('CapAdd') or []),'drop':sorted(host.get('CapDrop') or [])},'labels':{'org.opencontainers.image.revision':revision} if revision else {},'networks':sorted((c.get('NetworkSettings',{}).get('Networks') or {}).keys())})
print(json.dumps({'host':'hyper','read_only':True,'route_file':str(p),'resolved_route_file':str(config_target),'route_sha256':hashlib.sha256(t.encode()).hexdigest(),'routes':routes,'vhosts':vhosts,'listener_8084':lines,'docker_inventory_available':bool(docker),'inventory':inventory}))`;

const report = {
  schema: "cerp-blue-green-read-only-v1",
  collectedAt: new Date().toISOString(),
  action: "READ_ONLY_PLAN",
  promotion: {
    status: "NOT_ACTIVATABLE",
    remoteInterface: ["acquireRouteLock", "readRoute", "compareAndSwapRoute", "reloadAndVerifyRoute", "releaseRouteLock"],
    blockers: [
      "The API/worker runtime change from PR #1382 is not merged or live.",
      "A candidate service definition with private Traefik labels and a private health endpoint is not available.",
      "No proven old-worker drain and handoff protocol exists.",
    ],
  },
  vps: readOnlySsh(vpsSsh, vpsPython, "VPS"),
  hyper: readOnlySsh(hyperSsh, hyperPython, "HYPER"),
};
const file = path.join(__dirname, `blue-green-runtime-plan-${report.collectedAt.replace(/[:.]/g, "-")}.json`);
fs.writeFileSync(file, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ action: report.action, file, vps: { route_sha256: report.vps.route_sha256, routes: report.vps.routes, inventory: report.vps.inventory, docker_routes: report.vps.docker_routes, dynamic_files: report.vps.dynamic_files, dynamic_routes: report.vps.dynamic_routes, caddy_routes: report.vps.caddy_routes, proxy: report.vps.proxy, internal_api: report.vps.internal_api }, hyper: { route_sha256: report.hyper.route_sha256, routes: report.hyper.routes, vhosts: report.hyper.vhosts, listener_8084: report.hyper.listener_8084, inventory: report.hyper.inventory } }, null, 2));
