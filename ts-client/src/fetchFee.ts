import Redis from "ioredis";

const redis = new Redis();
let priorityFeeData;
let timer: NodeJS.Timeout;

const fetchFee = async () => {
  timer && clearTimeout(timer);
  priorityFeeData = await Promise.race([
    fetch(process.env.PRIORITY_FEE_KV).then((res) => res.json()),
    new Promise((resolve) => {
      setTimeout(() => {
        if (priorityFeeData) {
          resolve(priorityFeeData);
        }
      }, 1000);
    }),
  ]);
  const priorityFee: number = Math.min(
    1,
    Math.min(priorityFeeData.swapFee, 357107142)
  );
  redis.set("fee", priorityFee.toString());
  console.log("Fetched priority fee: ", priorityFee);
  timer = setTimeout(fetchFee, 1000);
};
function main() {
  fetchFee();
}

main();
