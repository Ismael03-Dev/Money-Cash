const express = require("express");
const cors = require("cors");
const { Redis } = require("@upstash/redis");

const app = express();
app.use(cors());
app.use(express.json());

const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const CASH_PREFIX = "cash:";
const USERS_SET = "cash:users";

async function getCashString(userId) {
    try {
        const raw = await redis.get(`${CASH_PREFIX}${userId}`);
        if (raw === null || raw === undefined) return "0";
        if (typeof raw === 'string') return raw;
        if (typeof raw === 'number') return raw.toString();
        if (typeof raw === 'object' && raw !== null) return raw.cash?.toString() || "0";
        return "0";
    } catch (err) {
        console.error("[getCashString]", err.message);
        return "0";
    }
}

async function getAllUserIds() {
    try {
        const ids = await redis.smembers(USERS_SET);
        return Array.isArray(ids) ? ids : [];
    } catch (err) {
        console.error("[getAllUserIds]", err.message);
        return [];
    }
}

function isValidCashString(str) {
    if (typeof str !== 'string') return false;
    return /^\d+$/.test(str);
}

app.get("/", (req, res) => {
    res.json({ message: "Cash API opérationnelle", version: "5.1" });
});

app.get("/api/migrate", async (req, res) => {
    try {
        const keys = await redis.keys(`${CASH_PREFIX}*`);
        let count = 0;
        for (const key of keys) {
            const userId = key.replace(CASH_PREFIX, "");
            if (userId && userId !== "users") {
                await redis.sadd(USERS_SET, userId);
                count++;
            }
        }
        res.json({ success: true, migrated: count });
    } catch (e) {
        console.error("[migrate]", e.message);
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get("/api/cash/top", async (req, res) => {
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit) || 50));
    try {
        const userIds = await getAllUserIds();
        if (userIds.length === 0) {
            return res.json({ success: true, data: [] });
        }

        const pipeline = redis.pipeline();
        for (const userId of userIds) {
            pipeline.get(`${CASH_PREFIX}${userId}`);
        }
        const results = await pipeline.exec();

        const users = userIds.map((userId, i) => {
            const raw = results[i];
            let cash = "0";
            if (raw !== null && raw !== undefined) {
                if (typeof raw === 'string') cash = raw;
                else if (typeof raw === 'number') cash = raw.toString();
                else if (typeof raw === 'object') cash = raw.cash?.toString() || "0";
            }
            return { userId, cash };
        });

        users.sort((a, b) => {
            const diff = BigInt(b.cash) - BigInt(a.cash);
            return diff > 0n ? 1 : diff < 0n ? -1 : 0;
        });

        res.json({ success: true, data: users.slice(0, limit) });
    } catch (error) {
        console.error("[top]", error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get("/api/cash/users", async (req, res) => {
    try {
        const userIds = await getAllUserIds();
        if (userIds.length === 0) {
            return res.json({ success: true, data: [] });
        }

        const pipeline = redis.pipeline();
        for (const userId of userIds) {
            pipeline.get(`${CASH_PREFIX}${userId}`);
        }
        const results = await pipeline.exec();

        const users = userIds.map((userId, i) => {
            const raw = results[i];
            let cash = "0";
            if (raw !== null && raw !== undefined) {
                if (typeof raw === 'string') cash = raw;
                else if (typeof raw === 'number') cash = raw.toString();
                else if (typeof raw === 'object') cash = raw.cash?.toString() || "0";
            }
            return { userId, cash };
        });

        res.json({ success: true, data: users });
    } catch (error) {
        console.error("[users]", error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get("/api/cash/:userId", async (req, res) => {
    const { userId } = req.params;
    try {
        const cashStr = await getCashString(userId);
        res.json({ success: true, data: { userId, cash: cashStr } });
    } catch (error) {
        console.error("[get]", error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post("/api/cash/:userId", async (req, res) => {
    const { userId } = req.params;
    const { cash } = req.body;
    if (cash === undefined || !isValidCashString(cash.toString()))
        return res.status(400).json({ success: false, error: "Montant invalide" });
    try {
        await redis.set(`${CASH_PREFIX}${userId}`, cash.toString());
        await redis.sadd(USERS_SET, userId);
        res.json({ success: true, data: { userId, cash: cash.toString() } });
    } catch (error) {
        console.error("[set]", error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post("/api/cash/:userId/add", async (req, res) => {
    const { userId } = req.params;
    const { amount } = req.body;
    if (!amount || !isValidCashString(amount.toString()))
        return res.status(400).json({ success: false, error: "Montant invalide" });
    try {
        const current = await getCashString(userId);
        const newCash = (BigInt(current) + BigInt(amount)).toString();
        await redis.set(`${CASH_PREFIX}${userId}`, newCash);
        await redis.sadd(USERS_SET, userId);
        res.json({ success: true, data: { userId, cash: newCash } });
    } catch (error) {
        console.error("[add]", error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post("/api/cash/:userId/subtract", async (req, res) => {
    const { userId } = req.params;
    const { amount } = req.body;
    if (!amount || !isValidCashString(amount.toString()))
        return res.status(400).json({ success: false, error: "Montant invalide" });
    try {
        const current = await getCashString(userId);
        const bigCurrent = BigInt(current);
        const bigAmount = BigInt(amount);
        if (bigCurrent < bigAmount)
            return res.status(400).json({ success: false, error: "Solde insuffisant" });
        const newCash = (bigCurrent - bigAmount).toString();
        await redis.set(`${CASH_PREFIX}${userId}`, newCash);
        await redis.sadd(USERS_SET, userId);
        res.json({ success: true, data: { userId, cash: newCash } });
    } catch (error) {
        console.error("[subtract]", error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post("/api/cash/reset-all", async (req, res) => {
    try {
        const { protectedIds = [] } = req.body;
        const userIds = await getAllUserIds();

        let resetCount = 0;
        let protectedCount = 0;
        let totalAmount = 0n;
        const details = [];

        for (const userId of userIds) {
            try {
                const cashStr = await getCashString(userId);
                const cash = BigInt(cashStr);

                if (protectedIds.includes(userId)) {
                    protectedCount++;
                    details.push(`🛡️ ${userId} - PROTÉGÉ (${cash.toLocaleString()})`);
                    continue;
                }

                if (cash > 0n) {
                    totalAmount += cash;
                    await redis.set(`${CASH_PREFIX}${userId}`, "0");
                    resetCount++;
                    details.push(`✅ ${userId} - ${cash.toLocaleString()} retiré`);
                }
            } catch (e) {
                console.error(`[reset-all] ${userId}:`, e.message);
            }
        }

        res.json({
            success: true,
            data: {
                resetCount,
                protectedCount,
                totalUsers: userIds.length,
                totalAmount: totalAmount.toString(),
                details: details.slice(0, 50)
            }
        });
    } catch (error) {
        console.error("[reset-all]", error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.delete("/api/cash/:userId", async (req, res) => {
    const { userId } = req.params;
    try {
        await redis.del(`${CASH_PREFIX}${userId}`);
        await redis.srem(USERS_SET, userId);
        res.json({ success: true, message: `Utilisateur ${userId} supprimé` });
    } catch (error) {
        console.error("[delete]", error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.delete("/api/cash/clear-all", async (req, res) => {
    try {
        const { confirm } = req.body;
        if (confirm !== "yes") {
            return res.status(400).json({
                success: false,
                error: "Confirmation requise: { confirm: 'yes' }"
            });
        }

        const userIds = await getAllUserIds();
        let deleted = 0;

        const pipeline = redis.pipeline();
        for (const userId of userIds) {
            pipeline.del(`${CASH_PREFIX}${userId}`);
        }
        pipeline.del(USERS_SET);
        await pipeline.exec();

        deleted = userIds.length;

        res.json({
            success: true,
            data: { deleted, message: "Tous les utilisateurs ont été supprimés" }
        });
    } catch (error) {
        console.error("[clear-all]", error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = app;
