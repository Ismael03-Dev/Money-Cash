const express = require("express");
const cors = require("cors");
const { MongoClient } = require("mongodb");

const app = express();
app.use(cors());
app.use(express.json());

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = "cashdb";
const COLLECTION_NAME = "users";

let client = null;
let db = null;
let usersCollection = null;

async function connectToDatabase() {
    if (db && usersCollection) return { db, usersCollection };

    if (!MONGODB_URI) {
        throw new Error("MONGODB_URI non configurée");
    }

    client = new MongoClient(MONGODB_URI, {
        maxPoolSize: 10,
        serverSelectionTimeoutMS: 5000
    });

    await client.connect();
    db = client.db(DB_NAME);
    usersCollection = db.collection(COLLECTION_NAME);

    await usersCollection.createIndex({ userId: 1 }, { unique: true });

    console.log("[MongoDB] Connecté avec succès");
    return { db, usersCollection };
}

function isValidCashString(str) {
    if (typeof str !== 'string') return false;
    return /^\d+$/.test(str);
}

connectToDatabase().catch(err => {
    console.error("[MongoDB] Erreur de connexion initiale:", err.message);
});

app.get("/", (req, res) => {
    res.json({ message: "Cash API opérationnelle (MongoDB)", version: "6.1" });
});

app.get("/api/cash/top", async (req, res) => {
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit) || 50));
    try {
        const { usersCollection } = await connectToDatabase();

        const users = await usersCollection.find({}).toArray();

        const sortedUsers = users.sort((a, b) => {
            const cashA = BigInt(a.cash || "0");
            const cashB = BigInt(b.cash || "0");
            if (cashA > cashB) return -1;
            if (cashA < cashB) return 1;
            return 0;
        });

        const data = sortedUsers.slice(0, limit).map(u => ({
            userId: u.userId,
            cash: u.cash || "0"
        }));

        res.json({ success: true, data });
    } catch (error) {
        console.error("[top]", error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get("/api/cash/users", async (req, res) => {
    try {
        const { usersCollection } = await connectToDatabase();

        const users = await usersCollection.find({}).toArray();

        const data = users.map(u => ({
            userId: u.userId,
            cash: u.cash || "0"
        }));

        res.json({ success: true, data });
    } catch (error) {
        console.error("[users]", error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get("/api/cash/:userId", async (req, res) => {
    const { userId } = req.params;
    try {
        const { usersCollection } = await connectToDatabase();

        const user = await usersCollection.findOne({ userId });

        res.json({
            success: true,
            data: { userId, cash: user?.cash || "0" }
        });
    } catch (error) {
        console.error("[get]", error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post("/api/cash/:userId", async (req, res) => {
    const { userId } = req.params;
    const { cash } = req.body;

    if (cash === undefined || !isValidCashString(cash.toString())) {
        return res.status(400).json({ success: false, error: "Montant invalide" });
    }

    try {
        const { usersCollection } = await connectToDatabase();

        await usersCollection.updateOne(
            { userId },
            { $set: { userId, cash: cash.toString(), updatedAt: new Date() } },
            { upsert: true }
        );

        res.json({ success: true, data: { userId, cash: cash.toString() } });
    } catch (error) {
        console.error("[set]", error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post("/api/cash/:userId/add", async (req, res) => {
    const { userId } = req.params;
    const { amount } = req.body;

    if (!amount || !isValidCashString(amount.toString())) {
        return res.status(400).json({ success: false, error: "Montant invalide" });
    }

    try {
        const { usersCollection } = await connectToDatabase();

        const user = await usersCollection.findOne({ userId });
        const current = user?.cash || "0";
        const newCash = (BigInt(current) + BigInt(amount)).toString();

        await usersCollection.updateOne(
            { userId },
            { $set: { cash: newCash, updatedAt: new Date() } },
            { upsert: true }
        );

        res.json({ success: true, data: { userId, cash: newCash } });
    } catch (error) {
        console.error("[add]", error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post("/api/cash/:userId/subtract", async (req, res) => {
    const { userId } = req.params;
    const { amount } = req.body;

    if (!amount || !isValidCashString(amount.toString())) {
        return res.status(400).json({ success: false, error: "Montant invalide" });
    }

    try {
        const { usersCollection } = await connectToDatabase();

        const user = await usersCollection.findOne({ userId });
        const current = user?.cash || "0";
        const bigCurrent = BigInt(current);
        const bigAmount = BigInt(amount);

        if (bigCurrent < bigAmount) {
            return res.status(400).json({ success: false, error: "Solde insuffisant" });
        }

        const newCash = (bigCurrent - bigAmount).toString();

        await usersCollection.updateOne(
            { userId },
            { $set: { cash: newCash, updatedAt: new Date() } }
        );

        res.json({ success: true, data: { userId, cash: newCash } });
    } catch (error) {
        console.error("[subtract]", error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post("/api/cash/reset-all", async (req, res) => {
    try {
        const { protectedIds = [] } = req.body;
        const { usersCollection } = await connectToDatabase();

        const users = await usersCollection.find({}).toArray();

        let resetCount = 0;
        let protectedCount = 0;
        let totalAmount = 0n;
        const details = [];

        for (const user of users) {
            const cash = BigInt(user.cash || "0");

            if (protectedIds.includes(user.userId)) {
                protectedCount++;
                details.push(`🛡️ ${user.userId} - PROTÉGÉ (${cash.toLocaleString()})`);
                continue;
            }

            if (cash > 0n) {
                totalAmount += cash;
                await usersCollection.updateOne(
                    { userId: user.userId },
                    { $set: { cash: "0", updatedAt: new Date() } }
                );
                resetCount++;
                details.push(`✅ ${user.userId} - ${cash.toLocaleString()} retiré`);
            }
        }

        res.json({
            success: true,
            data: {
                resetCount,
                protectedCount,
                totalUsers: users.length,
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
        const { usersCollection } = await connectToDatabase();

        const result = await usersCollection.deleteOne({ userId });

        res.json({
            success: true,
            message: result.deletedCount > 0
                ? `Utilisateur ${userId} supprimé`
                : `Utilisateur ${userId} introuvable`
        });
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

        const { usersCollection } = await connectToDatabase();
        const result = await usersCollection.deleteMany({});

        res.json({
            success: true,
            data: { deleted: result.deletedCount, message: "Tous les utilisateurs ont été supprimés" }
        });
    } catch (error) {
        console.error("[clear-all]", error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = app;