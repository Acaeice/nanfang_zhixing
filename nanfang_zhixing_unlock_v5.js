/**
 * 南方智行 终极解锁 + 抓包排查合体脚本 v5.1
 * 既做安全解锁，又在拦截时打印真实的 JSON 结构用于排查问题。
 * 支持 Loon 远程直连。
 */

const FUTURE_TIME = "2099-12-31 23:59:59";
const FUTURE_TIMESTAMP = 4102415999000;
const SCRIPT_NAME = "南方智行";

const url = $request.url;
let body = $response.body;

const EXACT_TIME_FIELDS = new Set([
    "tboxExpireTime", "tboxBuyBeforeExpireTime", "tboxBuyAfterExpireTime",
    "iotEndTime", "serviceExpireTime", "serviceEndTime", "vipExpire", "vipExpireTime", "expireTime"
]);

function deepModifySafe(target, modified) {
    if (!target || typeof target !== "object") return;
    if (Array.isArray(target)) {
        target.forEach(item => deepModifySafe(item, modified));
        return;
    }
    for (let key in target) {
        if (!target.hasOwnProperty(key)) continue;
        let val = target[key];

        if (EXACT_TIME_FIELDS.has(key)) {
            if (val !== null && val !== undefined && val !== "") {
                let newVal = (typeof val === "number") ? FUTURE_TIMESTAMP : FUTURE_TIME;
                if (val !== newVal) {
                    target[key] = newVal;
                    modified.count++;
                    console.log(`[${SCRIPT_NAME}] ⏳ 延期字段: ${key} -> ${newVal}`);
                }
            }
        } else if (key === "isExpired" || key === "isExpire") {
            let newVal = val;
            if (typeof val === "number") newVal = 0;
            else if (typeof val === "string") newVal = "0";
            else if (typeof val === "boolean") newVal = false;
            if (val !== newVal) {
                target[key] = newVal;
                modified.count++;
                console.log(`[${SCRIPT_NAME}] 🟢 抹除过期: ${key} -> ${newVal}`);
            }
        } else if (key === "serviceStatus" || key === "payStatus") {
            let newVal = val;
            if (typeof val === "number") newVal = 1;
            else if (typeof val === "string") newVal = "1";
            if (val !== newVal) {
                target[key] = newVal;
                modified.count++;
                console.log(`[${SCRIPT_NAME}] 🟢 激活状态: ${key} -> ${newVal}`);
            }
        }
        if (typeof target[key] === "object" && target[key] !== null) {
            deepModifySafe(target[key], modified);
        }
    }
}

try {
    if (body) {
        let obj = JSON.parse(body);
        let modified = { count: 0 };
        
        // --- 新增：打印原始数据逻辑 ---
        if (url.indexOf("/car/page") !== -1 || url.indexOf("/car/detail") !== -1) {
            console.log(`\n========== ${SCRIPT_NAME} HTTP 数据转储(原版) ==========`);
            console.log("👉 接口URL: " + url);
            let dumpStr = JSON.stringify(obj, function(k, v) {
                if (k === "vin" || k === "plateNum" || k === "phone" || k === "imei" || k === "iccid") {
                    return "***[脱敏保护]***"; 
                }
                return v;
            }, 2);
            console.log(dumpStr);
            console.log(`========== ${SCRIPT_NAME} 转储结束 ==========\n`);
        }

        // 进行精确不干预解锁
        deepModifySafe(obj, modified);

        if (modified.count > 0) {
            body = JSON.stringify(obj);
            console.log(`[${SCRIPT_NAME}] ✅ 处理完成，共解锁 ${modified.count} 处订阅限制。`);
        }
    }
} catch (e) {
    // 静默失败
}

$done({ body });
