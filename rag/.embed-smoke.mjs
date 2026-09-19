import { pipeline } from "@xenova/transformers";
const p = await pipeline("feature-extraction", "Xenova/bge-small-en-v1.5");
const out = await p("card testing sequence", { pooling: "mean", normalize: true });
console.log("dims:", out.dims, "len:", Array.from(out.data).length, "first:", Array.from(out.data).slice(0,3));
