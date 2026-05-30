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

const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN || "2UbuOKip5JmCrMVd94a87292d68376e6401d14430704fb4af";

function normalizarDatos(raw, documento) {
    const comparendos = (raw.comparendos || []).map(c => ({
        tipo: c.tipoComparendo || 'Comparendo',
        numero_comparendo: c.numeroComparendo || '',
        fecha_comparendo: c.fechaImposicion || '',
        placa: c.placa || '',
        secretaria: c.secretariaNombre || c.secretaria || '',
        infraccion: c.codigoInfraccion ? `${c.codigoInfraccion}\n${c.descripcionInfraccion || ''}` : '',
        estado: c.estadoComparendo || '',
        valor: c.valorComparendo || 0,
        valor_a_pagar: c.valorAPagar || c.totalAPagar || 0,
        notificacion: c.notificacion || ''
    }));

    const multas = (raw.multas || []).map(m => ({
        tipo: 'Multa',
        numero_comparendo: m.numeroMulta || '',
        fecha_comparendo: m.fechaResolucion || '',
        placa: m.placa || '',
        secretaria: m.secretariaNombre || m.secretaria || '',
        infraccion: m.codigoInfraccion ? `${m.codigoInfraccion}\n${m.descripcionInfraccion || ''}` : '',
        estado: m.estadoMulta || '',
        valor: m.valorMulta || 0,
        valor_a_pagar: m.valorAPagar || 0,
        notificacion: ''
    }));

    const acuerdos = (raw.acuerdosPago || []).map(a => ({
        numero_acuerdo: a.resolucion || '',
        fecha_acuerdo: a.fechaResolucion ? a.fechaResolucion.split(' ')[0] : '',
        secretaria: a.secretaria || '',
        valor_acuerdo: a.valorAcuerdo || 0,
        pendiente: a.pendiente || 0,
        cuota: `${a.cantCuotasPendientes || 0} cuotas pendientes`,
        valor_a_pagar: a.totalPagar || a.pendiente || 0
    }));

    if (acuerdos.length > 0 && comparendos.length === 0 && multas.length === 0) {
        return { tipo: 'acuerdos', data: acuerdos, totalGeneral: raw.totalGeneral || 0 };
    }

    return { data: [...comparendos, ...multas], totalGeneral: raw.totalGeneral || 0 };
}

async function consultarSIMIT(documento) {
    // Conectar a Browserless
    const browser = await puppeteer.connect({
        browserWSEndpoint: `wss://production-sfo.browserless.io?token=${BROWSERLESS_TOKEN}`,
    });

    const page = await browser.newPage();

    try {
        await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
        await page.setViewport({ width: 1280, height: 720 });

        let simitData = null;

        page.on('response', async (response) => {
            const url = response.url();
            if (url.includes('consulta') || url.includes('estadocuenta')) {
                try {
                    const ct = response.headers()['content-type'] || '';
                    if (ct.includes('json')) {
                        const json = await response.json();
                        if (json && (
                            json.comparendos !== undefined ||
                            json.multas !== undefined ||
                            json.acuerdosPago !== undefined ||
                            json.pazSalvo !== undefined
                        )) {
                            console.log('✅ Datos SIMIT interceptados');
                            simitData = json;
                        }
                    }
                } catch(e) {}
            }
        });

        await page.goto(`https://fcm.org.co/simit/#/estado-cuenta`, {
            waitUntil: "networkidle2",
            timeout: 30000
        });

        await new Promise(r => setTimeout(r, 3000));

        // Llenar input
        await page.evaluate((doc) => {
            const inputs = [...document.querySelectorAll('input')].filter(i =>
                i.type !== 'hidden' && i.type !== 'checkbox' && i.type !== 'radio' &&
                !i.id?.includes('email') && !i.name?.includes('email')
            );
            if (inputs.length > 0) {
                inputs[0].focus();
                inputs[0].value = doc;
                ['input', 'change', 'keyup'].forEach(ev =>
                    inputs[0].dispatchEvent(new Event(ev, { bubbles: true }))
                );
            }
        }, documento);

        await new Promise(r => setTimeout(r, 500));
        await page.keyboard.press('Enter');

        // Esperar datos
        await new Promise((resolve) => {
            const interval = setInterval(() => {
                if (simitData) { clearInterval(interval); resolve(); }
            }, 300);
            setTimeout(() => { clearInterval(interval); resolve(); }, 20000);
        });

        await page.close();
        await browser.disconnect();

        if (!simitData) {
            return { ok: false, error: "SIMIT no respondió a tiempo" };
        }

        const normalizado = normalizarDatos(simitData, documento);

        if (normalizado.tipo === 'acuerdos') {
            return { ok: true, status: 'ok', tipo: 'acuerdos', data: normalizado.data, totalGeneral: normalizado.totalGeneral };
        }

        const resultados = normalizado.data || [];
        return { ok: true, status: resultados.length === 0 ? 'notfound' : 'ok', data: resultados, totalGeneral: normalizado.totalGeneral };

    } catch (error) {
        await page.close().catch(() => {});
        await browser.disconnect().catch(() => {});
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

app.get("/", (req, res) => res.json({ status: "ok", message: "SIMIT Scraper via Browserless" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Scraper Browserless en puerto ${PORT}`));
