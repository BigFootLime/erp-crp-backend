import { describe, expect, it, vi } from 'vitest';
const generation = vi.hoisted(() => ({loadApplicableTechnicalSnapshot:vi.fn(),loadFabricationGenerationTree:vi.fn()}));
vi.mock('../module/production/domain/of-generation', () => generation);
import { planAssemblyRequirements } from '../module/commande-client/domain/assembly-planning';
const id = (n:number) => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;

describe('assembly purchased requirements preserve manufacturing occurrences', () => {
  it('reads each piece/version once while retaining separate purchased quantities for two occurrences of the same component', async () => {
    const root=id(1), child=id(2), rootVersion=id(11), childVersion=id(21), rootArticle=id(101), childArticle=id(102);
    const base={bom_line_id:null,parent_piece_technique_id:null,article_id:null,code_piece:'FIXTURE',designation:'Fixture',version_number:1,ordre_affichage:0,quantite_par_parent:1,quantite_cumulee:1};
    generation.loadFabricationGenerationTree.mockResolvedValue([
      {...base,key:root,parent_key:null,piece_technique_id:root,level:0},
      {...base,key:root+'/first',parent_key:root,piece_technique_id:child,parent_piece_technique_id:root,level:1,bom_line_id:id(301)},
      {...base,key:root+'/second',parent_key:root,piece_technique_id:child,parent_piece_technique_id:root,level:1,bom_line_id:id(302),quantite_par_parent:2},
    ]);
    generation.loadApplicableTechnicalSnapshot.mockResolvedValue({version_id:childVersion});
    const query=vi.fn(async(sql:unknown,_params?:unknown[])=>{
      const text=String(sql);
      if(text.includes('FROM public.piece_technique_versions'))return{rows:[{id:rootVersion,statut:'APPLICABLE',effective:true,manufacturing_mode:'ASSEMBLY',assembly_supply_strategy:'MAKE_TO_ORDER'}]};
      if(text.includes('FROM public.articles article'))return{rows:[{piece_technique_id:child,article_id:childArticle,article_code:'CHILD',designation:'Child'}]};
      if(text.includes('FROM public.pieces_techniques_nomenclature line'))return{rows:[{source_line_id:id(401),piece_technique_id:child,parent_piece_technique_version_id:childVersion,article_id:id(103),article_code:'RAW',designation:'Raw material',quantity_per_parent:110.5,source_kind:'PURCHASE'}]};
      return{rows:[]};
    });
    const plan=await planAssemblyRequirements({query} as never,{root_article_id:rootArticle,root_piece_technique_id:root,root_piece_technique_version_id:rootVersion,quantity:4,due_date:'2026-10-30'});
    const purchases=plan.components.filter(c=>c.kind==='PURCHASED');
    expect(purchases.map(c=>[c.parent_structure_path,c.required_qty])).toEqual([[root+'/first',442],[root+'/second',884]]);
    expect(new Set(purchases.map(c=>c.structure_path)).size).toBe(2);
    const purchaseQuery=query.mock.calls.find(call=>String(call[0]).includes('FROM public.pieces_techniques_nomenclature line'));
    expect(purchaseQuery?.[1]).toEqual([[root,child],[rootVersion,childVersion]]);
    expect(plan.planned_of_quantities_by_path).toEqual({[root]:4,[root+'/first']:4,[root+'/second']:8});
  });
});
