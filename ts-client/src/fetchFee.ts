
import Redis from "ioredis";

const redis = new Redis();

const fetchFee = async () => {
    const priorityFeeData = await fetch(process.env.PRIORITY_FEE_KV).then((res) =>
        res.json()
    );
    const priorityFee: number = Math.min(
        1,
        Math.min(priorityFeeData.swapFee, 357107142)
    );
    redis.set("fee", priorityFee.toString());
    console.log("Fetched priority fee: ", priorityFee)
}
function main() {
    setInterval(() => {
        fetchFee();
    }, 1000)
}

main();