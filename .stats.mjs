import sharp from "sharp";
const [,, a, l, t, w, h] = process.argv;
const { data, info } = await sharp(a).extract({left:+l,top:+t,width:+w,height:+h}).raw().toBuffer({resolveWithObject:true});
let sum=0, n=0, lo=255, hi=0;
const hist=new Array(8).fill(0);
for (let i=0;i<data.length;i+=info.channels){
  const y=0.2126*data[i]+0.7152*data[i+1]+0.0722*data[i+2];
  sum+=y;n++;lo=Math.min(lo,y);hi=Math.max(hi,y);hist[Math.min(7,Math.floor(y/32))]++;
}
console.log(a, "mean", (sum/n).toFixed(1), "min", lo.toFixed(0), "max", hi.toFixed(0), "hist", hist.map(v=>(100*v/n).toFixed(0)).join("/"));
