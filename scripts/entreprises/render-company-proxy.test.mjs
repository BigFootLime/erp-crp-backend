import assert from "node:assert/strict";
import test from "node:test";
import {
  renderCompanyProxyInclude,
  validateCompanyProxyManifest,
} from "./render-company-proxy.mjs";

const crp = "11111111-1111-4111-8111-111111111111";
const ec = "22222222-2222-4222-8222-222222222222";
const manifest = {
  companies: [
    {
      company_id: crp,
      environment: "prod",
      database: "cerp_prod",
      profile: "INDUSTRIAL",
      commercial_api_worker: false,
      target: { profile: "local", origin: "http://127.0.0.1:8080" },
    },
    {
      company_id: ec,
      environment: "prod",
      database: "cerp_company_22222222222242228222222222222222_prod",
      profile: "COMMERCIAL",
      commercial_api_worker: false,
      target: { profile: "local", origin: "http://127.0.0.1:8090" },
    },
  ],
};

test("renders fixed HTTP and Socket.IO routes before fail-closed guards", () => {
  const output = renderCompanyProxyInclude(manifest);
  assert.ok(output.includes(`X-CERP-Company} ^${ec}$`));
  assert.ok(output.includes("X-CERP-Database} ^cerp_prod$"));
  assert.ok(!output.includes("cerp_company_22222222222242228222222222222222_prod"));
  assert.match(output, /ws:\/\/127\.0\.0\.1:8090\/socket\.io/);
  assert.match(output, /http:\/\/127\.0\.0\.1:8090\/socket\.io/);
  assert.match(output, /non-empty company is fail-closed/);
  assert.ok(
    output.indexOf("http://127.0.0.1:8090/api/v1/") <
      output.indexOf("unknown/malformed company"),
  );
});

test("accepts legacy CRP and a new EC production instance without target sharing", () => {
  const routes = validateCompanyProxyManifest(manifest);
  assert.equal(routes.length, 2);
  assert.equal(routes[0].database, "cerp_prod");
  assert.equal(routes[1].environment, "prod");
});

test("allows distinct companies in one canonical environment without exposing their internal sites", () => {
  const third = {
    company_id: "33333333-3333-4333-8333-333333333333",
    environment: "prod",
    database: "cerp_company_33333333333343338333333333333333_prod",
    profile: "INDUSTRIAL",
    commercial_api_worker: false,
    target: { profile: "local", origin: "http://127.0.0.1:8091" },
  };
  const output = renderCompanyProxyInclude({ companies: [...manifest.companies, third] });
  expectOccurrences(output, "X-CERP-Database} ^cerp_prod$", 3);
  assert.ok(!output.includes(third.database));
});

test("rejects unsafe targets, unknown fields and injection-shaped values", () => {
  const variants = [
    { ...manifest, dsn: "postgres://forbidden" },
    {
      companies: [
        {
          ...manifest.companies[0],
          target: { profile: "local", origin: "http://evil.example:8080" },
        },
      ],
    },
    {
      companies: [
        {
          ...manifest.companies[0],
          target: { profile: "local", origin: "http://127.0.0.1:8080/path" },
        },
      ],
    },
    {
      companies: [
        {
          ...manifest.companies[0],
          database: "cerp_prod\nProxyPass / http://evil",
        },
      ],
    },
    {
      companies: [
        { ...manifest.companies[0], company_id: `${crp}\nRewriteRule` },
      ],
    },
  ];
  for (const variant of variants) {
    assert.throws(
      () => validateCompanyProxyManifest(variant),
      /BUSINESS_COMPANY_PROXY_INVALID/,
    );
  }
});

function expectOccurrences(value, token, count) {
  assert.equal(value.split(token).length - 1, count);
}

test("rejects duplicate routes and target sharing", () => {
  assert.throws(
    () =>
      validateCompanyProxyManifest({
        companies: [manifest.companies[0], manifest.companies[0]],
      }),
    /unique/,
  );
  assert.throws(
    () =>
      validateCompanyProxyManifest({
        companies: [
          manifest.companies[0],
          { ...manifest.companies[1], target: manifest.companies[0].target },
        ],
      }),
    /target origin must be unique/,
  );
});

test("rejects commercial external workers and environment/database mismatches", () => {
  assert.throws(
    () =>
      validateCompanyProxyManifest({
        companies: [{ ...manifest.companies[1], commercial_api_worker: true }],
      }),
    /commercial companies require/,
  );
  assert.throws(
    () =>
      validateCompanyProxyManifest({
        companies: [
          {
            ...manifest.companies[1],
            database: "cerp_company_22222222222242228222222222222222_test",
          },
        ],
      }),
    /database does not match/,
  );
});
