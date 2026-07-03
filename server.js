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

async function getCashString(userId) {
    const raw = await redis.get(`${CASH_PREFIX}${userId}`);
    if (raw === null || raw === undefined) return "0";
    if (typeof raw === 'string') return raw;
    if (typeof raw === 'number') return raw.toString();
    if (typeof raw === 'object' && raw !== null) return raw.cash?.toString() || "0";
    return "0";
}

function isValidCashString(str) {
    if (typeof str !== 'string') return false;
    return /^\d+$/.test(str);
}

app.get("/", (req, res) => {
    res.json({ message: "Cash API opérationnelle", version: "4.0" });
});

app.get("/api/cash/top", async (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    try {
        const keys = await redis.keys(`${CASH_PREFIX}*`);
        const users = [];
        for (const key of keys) {
            const userId = key.replace(CASH_PREFIX, "");
            const cashStr = await getCashString(userId);
            users.push({ userId, cash: cashStr });
        }
        users.sort((a, b) => {
            const diff = BigInt(b.cash) - BigInt(a.cash);
            return diff > 0n ? 1 : diff < 0n ? -1 : 0;
        });
        res.json({ success: true, data: users.slice(0, limit) });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get("/api/cash/users", async (req, res) => {
    try {
        const keys = await redis.keys(`${CASH_PREFIX}*`);
        const users = [];
        for (const key of keys) {
            const userId = key.replace(CASH_PREFIX, "");
            const cashStr = await getCashString(userId);
            users.push({ userId, cash: cashStr });
        }
        res.json({ success: true, data: users });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get("/api/cash/:userId", async (req, res) => {
    const { userId } = req.params;
    try {
        const cashStr = await getCashString(userId);
        res.json({ success: true, data: { userId, cash: cashStr } });
    } catch (error) {
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
        res.json({ success: true, data: { userId, cash: cash.toString() } });
    } catch (error) {
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
        res.json({ success: true, data: { userId, cash: newCash } });
    } catch (error) {
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
        res.json({ success: true, data: { userId, cash: newCash } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post("/api/cash/reset-all", async (req, res) => {
    try {
        const { protectedIds = [] } = req.body;
        const keys = await redis.keys(`${CASH_PREFIX}*`);
        
        let resetCount = 0;
        let protectedCount = 0;
        let totalAmount = 0n;
        const details = [];

        for (const key of keys) {
            const userId = key.replace(CASH_PREFIX, "");
            const cashStr = await getCashString(userId);
            const cash = BigInt(cashStr);

            if (protectedIds.includes(userId)) {
                protectedCount++;
                details.push(`🛡️ ${userId} - PROTÉGÉ (${cash.toLocaleString()})`);
                continue;
            }

            if (cash > 0n) {
                totalAmount += cash;
                await redis.set(key, "0");
                resetCount++;
                details.push(`✅ ${userId} - ${cash.toLocaleString()} retiré`);
            }
        }

        res.json({
            success: true,
            data: {
                resetCount,
                protectedCount,
                totalUsers: keys.length,
                totalAmount: totalAmount.toString(),
                details: details.slice(0, 50)
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.delete("/api/cash/:userId", async (req, res) => {
    const { userId } = req.params;
    try {
        await redis.del(`${CASH_PREFIX}${userId}`);
        res.json({ success: true, message: `Utilisateur ${userId} supprimé` });
    } catch (error) {
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
        
        const keys = await redis.keys(`${CASH_PREFIX}*`);
        let deleted = 0;
        for (const key of keys) {
            await redis.del(key);
            deleted++;
        }
        
        res.json({ 
            success: true, 
            data: { deleted, message: "Tous les utilisateurs ont été supprimés" } 
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = app;
