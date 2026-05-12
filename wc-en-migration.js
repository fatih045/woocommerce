/**
 * wc-en-migration.js
 * 
 * WooCommerce ürünlerini Bulgarca'dan İngilizce'ye çevirir.
 * Polylang'ın EN kaydına yazar.
 * 
 * Kullanım:
 *   node wc-en-migration.js
 *   node wc-en-migration.js --dry-run   (sadece göster, yazma)
 *   node wc-en-migration.js --limit=10  (ilk 10 ürün)
 */

// ─── AYARLAR ────────────────────────────────────────────────────────────────
require("dotenv").config();
const CONFIG = {
    siteUrl: process.env.SITE_URL,

    consumerKey: process.env.WC_CONSUMER_KEY,
    consumerSecret: process.env.WC_CONSUMER_SECRET,

    openaiApiKey: process.env.OPENAI_API_KEY,
    openaiModel: process.env.OPENAI_MODEL || "gpt-4.1-nano",

    batchSize: 5,
    delayMs: 1000,

    dryRun: process.argv.includes("--dry-run"),

    limit: getArg("--limit")
        ? parseInt(getArg("--limit"))
        : null,
};


// ─── YARDIMCI FONKSİYONLAR ──────────────────────────────────────────────────

function getArg(name) {
    const arg = process.argv.find(a => a.startsWith(name + "="));
    return arg ? arg.split("=")[1] : null;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function log(msg, type = "info") {
    const prefix = { info: "ℹ", ok: "✓", err: "✗", warn: "⚠" }[type] || "•";
    console.log(`${prefix}  ${msg}`);
}

// ─── WC API ─────────────────────────────────────────────────────────────────

const wcAuth = Buffer.from(`${CONFIG.consumerKey}:${CONFIG.consumerSecret}`).toString("base64");

async function wcGet(endpoint, params = {}) {
    const url = new URL(`${CONFIG.siteUrl}/wp-json/wc/v3/${endpoint}`);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    const res = await fetch(url.toString(), {
        headers: { Authorization: `Basic ${wcAuth}` }
    });
    if (!res.ok) throw new Error(`WC GET ${endpoint} → ${res.status}: ${await res.text()}`);
    return res.json();
}

async function wcPut(endpoint, body) {
    const res = await fetch(`${CONFIG.siteUrl}/wp-json/wc/v3/${endpoint}`, {
        method: "PUT",
        headers: {
            Authorization: `Basic ${wcAuth}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`WC PUT ${endpoint} → ${res.status}: ${await res.text()}`);
    return res.json();
}

// Tüm ürünleri çek (pagination)
async function fetchAllProducts() {
    const products = [];
    let page = 1;
    while (true) {
        const batch = await wcGet("products", { per_page: 100, page, lang: "bg" });
        if (!batch.length) break;
        products.push(...batch);
        log(`Sayfa ${page} çekildi — ${batch.length} ürün`);
        if (batch.length < 100) break;
        page++;
        await sleep(CONFIG.delayMs);
    }
    return products;
}

// ─── OPENAI API ─────────────────────────────────────────────────────────────

async function translateProduct(product) {
    const prompt = `You are a professional product translator for a Turkish wholesale bakery/food store.
Translate the following WooCommerce product from Bulgarian to English.
Return ONLY a JSON object with these fields: name, short_description, description
Keep HTML tags if present. Make the translation SEO-friendly and natural.
Do not add any explanation, only the JSON object.

Product:
Name: ${product.name}
Short description: ${product.short_description || ""}
Description: ${product.description || ""}`;

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${CONFIG.openaiApiKey}`
        },
        body: JSON.stringify({
            model: CONFIG.openaiModel,
            max_tokens: 1000,
            messages: [
                { role: "system", content: "You are a professional product translator. Always respond with valid JSON only." },
                { role: "user", content: prompt }
            ]
        })
    });

    if (!res.ok) throw new Error(`OpenAI API → ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const text = data.choices[0].message.content.trim();

    // JSON parse
    const clean = text.replace(/```json|```/g, "").trim();
    return JSON.parse(clean);
}

// ─── POLYLANG EN KAYDI ───────────────────────────────────────────────────────

// Polylang REST API üzerinden EN çevirisini yaz
async function writeEnglishTranslation(productId, translated) {
    // Polylang WC entegrasyonu: lang=en parametresiyle PUT
    return wcPut(`products/${productId}`, {
        name: translated.name,
        short_description: translated.short_description || "",
        description: translated.description || "",
        lang: "en"
    });
}

// ─── ANA AKIŞ ───────────────────────────────────────────────────────────────

async function main() {
    console.log("\n═══════════════════════════════════════");
    console.log("  WC EN Migration — toptan.pastane.bg  ");
    console.log("═══════════════════════════════════════\n");

    if (CONFIG.dryRun) log("DRY RUN modu — hiçbir şey yazılmayacak", "warn");
    if (!CONFIG.openaiApiKey) {
        log("openaiApiKey boş! CONFIG içine API key'ini gir.", "err");
        process.exit(1);
    }

    // 1. Ürünleri çek
    log("Bulgarca ürünler çekiliyor...");
    let products = await fetchAllProducts();
    log(`Toplam ${products.length} ürün bulundu`, "ok");

    if (CONFIG.limit) {
        products = products.slice(0, CONFIG.limit);
        log(`--limit=${CONFIG.limit} — sadece ilk ${products.length} ürün işlenecek`, "warn");
    }

    // 2. Çeviri ve yükleme
    let success = 0, failed = 0;
    const errors = [];

    for (let i = 0; i < products.length; i++) {
        const p = products[i];
        const progress = `[${i + 1}/${products.length}]`;

        try {
            log(`${progress} Çevriliyor: "${p.name}"`);
            const translated = await translateProduct(p);
            log(`${progress} → "${translated.name}"`, "ok");

            if (!CONFIG.dryRun) {
                await writeEnglishTranslation(p.id, translated);
                log(`${progress} Polylang EN kaydına yazıldı`, "ok");
            }

            success++;
        } catch (err) {
            log(`${progress} HATA: ${err.message}`, "err");
            errors.push({ id: p.id, name: p.name, error: err.message });
            failed++;
        }

        // Rate limit için bekle
        if (i < products.length - 1) await sleep(CONFIG.delayMs);
    }

    // 3. Özet
    console.log("\n═══════════════════════════════════════");
    console.log(`  TAMAMLANDI`);
    console.log(`  Başarılı : ${success}`);
    console.log(`  Hatalı   : ${failed}`);
    console.log("═══════════════════════════════════════\n");

    if (errors.length) {
        log("Hatalı ürünler:", "warn");
        errors.forEach(e => console.log(`  ID:${e.id} "${e.name}" → ${e.error}`));
    }
}

main().catch(err => {
    log(`Kritik hata: ${err.message}`, "err");
    process.exit(1);
});