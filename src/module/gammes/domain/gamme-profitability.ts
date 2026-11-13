/** Both operation and part margins use revenue as denominator; unknown costs never get a profitable colour. */
export function profitability(revenue:number|null,cost:number|null){
 const profit=revenue===null||cost===null?null:Math.round((revenue-cost)*100)/100;
 const percent=profit===null||revenue===null||revenue<=0?null:Math.round(profit/revenue*10000)/100;
 const level=profit!==null&&profit<0?'LOSS':percent===null?'UNKNOWN':percent>=20?'STRONG':percent>=10?'GOOD':'TIGHT';
 return {revenue,cost,profit,percent,level};
}
