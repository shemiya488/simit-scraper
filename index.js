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

let browser = null;

async function getBrowser() {
    if (!browser || !browser.isConnected()) {
        browser = await puppeteer.launch({
            headless: "new",
            args: [
                "--no-sandbox",
                "--disable-setuid-sandbox", 
                "--disable-dev-shm-usage",
                "--disable-gpu",
                "--disable-blink-features=AutomationControlled",
                "--window-size=1280,720"
            ]
        });
    }
    return browser;
}

getBrowser().catch(console.error);

async function consultarSIMIT(documento) {
    const b = await getBrowser();
    const page = await b.newPage();

    try {
        // Evitar detección de bot
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
            Object.defineProperty(navigator, 'languages', { get: () => ['es-CO', 'es', 'en'] });
            Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
        });

        await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
        await page.setViewport({ width: 1280, height: 720 });

        let simitData = null;
        let urlsVistas = [];

        page.on('response', async (response) => {
            const url = response.url();
            urlsVistas.push(url);
            try {
                const ct = response.headers()['content-type'] || '';
                if (ct.includes('json')) {
                    const json = await response.json();
                    if (json && (
                        json.comparendos !== undefined || 
                        json.multas !== undefined ||
                        (json.data && typeof json.data === 'object' && (
                            json.data.comparendos !== undefined || 
                            json.data.multas !== undefined ||
                            json.data.cantMultasPagar !== undefined
                        ))
                    )) {
                        console.log('✅ Datos encontrados en:', url);
                        simitData = json;
                    }
                }
            } catch(e) {}
        });

        console.log('Navegando al SIMIT...');
        await page.goto("https://fcm.org.co/simit/#/estado-cuenta", {
            waitUntil: "networkidle2",
            timeout: 30000
        });

        console.log('Página cargada, buscando input...');
        await new Promise(r => setTimeout(r, 3000));

        // Tomar screenshot para debug
        const screenshot = await page.screenshot({ encoding: 'base64' });
        console.log('Screenshot tomado, tamaño:', screenshot.length);

        // Ver el HTML actual
        const html = await page.content();
        console.log('HTML length:', html.length);
        console.log('Inputs encontrados:', (html.match(/<input/g) || []).length);

        // Intentar llenar el input
        const inputFilled = await page.evaluate((doc) => {
            const inputs = [...document.querySelectorAll('input')].filter(i => 
                i.type !== 'hidden' && i.type !== 'checkbox' && i.type !== 'radio'
            );
            console.log('Inputs visibles:', inputs.length);
            if (inputs.length > 0) {
                inputs[0].focus();
                inputs[0].value = doc;
                ['input','change','keyup'].forEach(ev => 
                    inputs[0].dispatchEvent(new Event(ev, { bubbles: true }))
                );
                return true;
            }
            return false;
        }, documento);

        console.log('Input llenado:', inputFilled);
        await new Promise(r => setTimeout(r, 1000));
        await page.keyboard.press('Enter');
        console.log('Enter presionado, esperando respuesta...');

        // Esperar datos
        await new Promise((resolve) => {
            const interval = setInterval(() => {
                if (simitData) { clearInterval(interval); resolve(); }
            }, 300);
            setTimeout(() => { clearInterval(interval); resolve(); }, 20000);
        });

        console.log('URLs vistas:', urlsVistas.filter(u => u.includes('simit') || u.includes('fcm')));
        await page.close();

        if (!simitData) {
            return { ok: false, error: "SIMIT no respondió", urls: urlsVistas.slice(-10) };
        }

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
        if (!browser.isConnected()) browser = null;
        throw error;
    }
}

app.post("/api/simit", async (req, res) => {
    const documento = req.body.filtro || req.body.documento || req.body.placa;
    if (!documento) return res.status(400).json({ ok: false, error: "Documento requerido" });

    try {
        const result = await consultarSIMIT(documento);
        return res.json(result);
    } catch(e) {
        return res.status(500).json({ ok: false, error: e.message });
    }
});

app.get("/", (req, res) => res.json({ status: "ok", message: "SIMIT Scraper debug" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Scraper debug en puerto ${PORT}`));
