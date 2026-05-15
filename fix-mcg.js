const fs = require("fs");
const p = "extension/content.js";
let s = fs.readFileSync(p, "utf8");
const d = "div";
const broken =
  'ucrd-mcg-bar-fill ${cls}" style="height:${pctBar}%"></motion></' + d + "></" + d + ">`;";
const fixed =
  'ucrd-mcg-bar-fill ${cls}" style="height:${pctBar}%"></' + d + "></" + d + "></" + d + ">`;";
if (!s.includes(broken)) {
  console.error("not found");
  process.exit(1);
}
s = s.replace(broken, fixed);
fs.writeFileSync(p, s);
console.log("fixed");
