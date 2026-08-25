const {exec}=require("child_process");
function run(h,cb){exec("ping -c 1 "+h,cb);}
module.exports={run};
