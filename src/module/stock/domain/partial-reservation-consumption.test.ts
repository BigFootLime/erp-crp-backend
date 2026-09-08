import {describe,it,expect} from 'vitest';
import {partialReservationConsumption as consume} from './partial-reservation-consumption';
describe('consommation partielle du registre de réservation',()=>{
  it('consomme 20 sur 60 et conserve 40 réservés',()=>expect(consume({reserved:60,consumed:0,prepared:0,quantity:20})).toEqual({consumed:20,prepared:0,remaining:40,unreserve:20,status:'ACTIVE'}));
  it('consomme le dernier reliquat sans libérer les quantités déjà sorties une seconde fois',()=>expect(consume({reserved:60,consumed:20,prepared:10,quantity:40})).toEqual({consumed:60,prepared:0,remaining:0,unreserve:40,status:'CONSUMED'}));
  it('préserve les quantités préparées non encore consommées',()=>expect(consume({reserved:60,consumed:10,prepared:30,quantity:20})).toMatchObject({prepared:10,remaining:30}));
  it('ne laisse pas de reliquat fantôme après plusieurs débits décimaux',()=>{
    let consumed=0;
    for(let i=0;i<3;i++)consumed=consume({reserved:0.3,consumed,prepared:0,quantity:0.1}).consumed;
    expect(consumed).toBe(0.3);
  });
  it.each([0,-1,Infinity,0.0001,41])('refuse un débit invalide de %s sur un reliquat de 40',quantity=>expect(()=>consume({reserved:60,consumed:20,prepared:0,quantity})).toThrow());
});
