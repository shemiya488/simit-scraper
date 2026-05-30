const express = require("express");
const puppeteer = require("puppeteer");

const app = express();

app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.status(200).end();
    next();
});

app.use(express.json());

// =====================================================
// POOL DE NAVEGADORES — Chrome siempre listo
// =====================================================
let browser = null;
const queue = [];
let processing = false;

async function getBrowser() {
    if (!browser || !browser.isConnected()) {
        console.log("Iniciando Chrome...");
        browser = await puppeteer.launch({
            headless: "new",
            args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--window-size=1280,720"]
        });
        console.log("Chrome listo.");
    }
    return browser;
}

// Pre-calentar Chrome al arrancar
getBrowser().catch(console.error);

async function consultarSIMIT(documento) {
    const b = await getBrowser();
    const page = await b.newPage();

    try {
        await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36");

        // Interceptar respuesta del SIMIT
        let simitData = null;
        const responseHandler = async (response) => {
            const url = response.url();
            if (url.includes('consulta') && url.includes('simit')) {
                try {
                    const ct = response.headers()['content-type'] || '';
                    if (ct.includes('json')) {
                        const json = await response.json();
                        if (json && (json.comparendos !== undefined || json.multas !== undefined ||
                            (json.data && (json.data.comparendos !== undefined || json.data.multas !== undefined)))) {
                            simitData = json;
                        }
                    }
                } catch(e) {}
            }
        };
        page.on('response', responseHandler);

        // Navegar a la página
        await page.goto("https://fcm.org.co/simit/#/estado-cuenta", {
            waitUntil: "networkidle2",
            timeout: 25000
        });

        // Esperar que cargue el input
        await page.waitForSelector('input', { timeout: 10000 });
        await new Promise(r => setTimeout(r, 1500));

        // Llenar el campo y buscar
        await page.evaluate((doc) => {
            const inputs = [...document.querySelectorAll('input')].filter(i => 
                i.type !== 'hidden' && i.type !== 'checkbox' && i.type !== 'radio'
            );
            if (inputs[0]) {
                inputs[0].focus();
                inputs[0].value = doc;
                ['input','change','keyup'].forEach(ev => 
                    inputs[0].dispatchEvent(new Event(ev, { bubbles: true }))
                );
            }
        }, documento);

        await new Promise(r => setTimeout(r, 500));
        await page.keyboard.press('Enter');

        // Esperar datos — máximo 18 segundos
        await new Promise((resolve) => {
            const interval = setInterval(() => {
                if (simitData) { clearInterval(interval); resolve(); }
            }, 300);
            setTimeout(() => { clearInterval(interval); resolve(); }, 18000);
        });

        page.off('response', responseHandler);
        await page.close();

        if (!simitData) return { ok: false, error: "SIMIT no respondió a tiempo" };

        const rawData = simitData.data || simitData;
        const comparendos = (rawData.comparendos || []).map(c => ({
            tipo: c.tipoComparendo || 'Comparendo',
            numero_comparendo: c.numeroComparendo || '',
            fecha_comparendo: c.fechaImposicion || '',
            placa: c.placa || documento,
            secretaria: c.secretaria || c.organismoTransito || '',
            infraccion: c.codigoInfraccion ? `${c.codigoInfraccion}\n${c.descripcionInfraccion || ''}` : '',
            estado: c.estadoComparendo || '',
            valor: c.valorComparendo || 0,
            valor_a_pagar: c.valorAPagar || c.totalAPagar || 0,
            notificacion: c.notificacion || ''
        }));

        const multas = (rawData.multas || []).map(m => ({
            tipo: 'Multa',
            numero_comparendo: m.numeroMulta || '',
            fecha_comparendo: m.fechaResolucion || '',
            placa: m.placa || documento,
            secretaria: m.secretaria || '',
            infraccion: m.codigoInfraccion ? `${m.codigoInfraccion}\n${m.descripcionInfraccion || ''}` : '',
            estado: m.estadoMulta || '',
            valor: m.valorMulta || 0,
            valor_a_pagar: m.valorAPagar || 0,
            notificacion: ''
        }));

        const resultados = [...comparendos, ...multas];
        return { ok: true, status: resultados.length === 0 ? 'notfound' : 'ok', data: resultados };

    } catch (error) {
        await page.close().catch(() => {});
        // Si Chrome murió, reiniciarlo
        if (!browser.isConnected()) browser = null;
        throw error;
    }
}

// Cola de consultas — procesar de a una para no sobrecargar
async function processQueue() {
    if (processing || queue.length === 0) return;
    processing = true;
    const { documento, resolve, reject } = queue.shift();
    try {
        const result = await consultarSIMIT(documento);
        resolve(result);
    } catch(e) {
        reject(e);
    } finally {
        processing = false;
        processQueue(); // Procesar siguiente
    }
}

app.post("/api/simit", async (req, res) => {
    const documento = req.body.filtro || req.body.documento || req.body.placa;
    if (!documento) return res.status(400).json({ ok: false, error: "Documento requerido" });

    // Agregar a la cola
    const result = await new Promise((resolve, reject) => {
        queue.push({ documento, resolve, reject });
        processQueue();
    }).catch(e => ({ ok: false, error: e.message }));

    return res.json(result);
});

app.get("/", (req, res) => res.json({ 
    status: "ok", 
    message: "SIMIT Scraper v4 - Pool activo",
    cola: queue.length,
    chromeActivo: browser?.isConnected() || false
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Scraper v4 en puerto ${PORT}`);
});
