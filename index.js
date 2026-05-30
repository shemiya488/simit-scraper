const express = require("express");
const cors = require("cors");
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

app.post("/api/simit", async (req, res) => {
    const documento = req.body.filtro || req.body.documento || req.body.placa;
    if (!documento) return res.status(400).json({ ok: false, error: "Documento requerido" });

    let browser;
    try {
        browser = await puppeteer.launch({
            headless: "new",
            args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
        });

        const page = await browser.newPage();
        await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36");

        // Interceptar la respuesta del SIMIT directamente
        let simitData = null;
        page.on('response', async (response) => {
            const url = response.url();
            if (url.includes('estadocuenta/consulta') || url.includes('simit/microservices')) {
                try {
                    const json = await response.json();
                    simitData = json;
                } catch(e) {}
            }
        });

        await page.goto("https://fcm.org.co/simit/#/estado-cuenta", {
            waitUntil: "networkidle2",
            timeout: 30000
        });

        // Esperar campo de búsqueda
        await page.waitForSelector('input', { timeout: 15000 });

        // Encontrar y llenar el input
        await page.evaluate((doc) => {
            const inputs = document.querySelectorAll('input');
            for (const input of inputs) {
                if (input.type !== 'hidden' && input.type !== 'checkbox') {
                    input.value = doc;
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                    break;
                }
            }
        }, documento);

        await new Promise(r => setTimeout(r, 500));

        // Presionar Enter o click en buscar
        await page.keyboard.press('Enter');

        // Esperar respuesta del API interceptada o timeout
        await new Promise(r => setTimeout(r, 12000));

        await browser.close();

        if (simitData) {
            // Tenemos datos del API del SIMIT directamente
            const rawData = simitData.data || simitData;
            
            // Normalizar comparendos
            const comparendos = (rawData.comparendos || []).map(c => ({
                tipo: c.tipoComparendo || c.tipo || 'Comparendo',
                numero_comparendo: c.numeroComparendo || c.numero || '',
                fecha_comparendo: c.fechaImposicion || c.fecha || '',
                placa: c.placa || documento,
                secretaria: c.secretaria || c.organismoTransito || '',
                infraccion: c.codigoInfraccion ? `${c.codigoInfraccion}\n${c.descripcionInfraccion || ''}` : '',
                estado: c.estadoComparendo || c.estado || '',
                valor: c.valorComparendo || c.valor || 0,
                valor_a_pagar: c.valorAPagar || c.totalAPagar || c.valor || 0,
                notificacion: c.notificacion || ''
            }));

            // Normalizar multas
            const multas = (rawData.multas || []).map(m => ({
                tipo: 'Multa',
                numero_comparendo: m.numeroMulta || m.numero || '',
                fecha_comparendo: m.fechaResolucion || m.fecha || '',
                placa: m.placa || documento,
                secretaria: m.secretaria || '',
                infraccion: m.codigoInfraccion ? `${m.codigoInfraccion}\n${m.descripcionInfraccion || ''}` : '',
                estado: m.estadoMulta || m.estado || '',
                valor: m.valorMulta || m.valor || 0,
                valor_a_pagar: m.valorAPagar || m.totalAPagar || m.valor || 0,
                notificacion: m.notificacion || ''
            }));

            const resultados = [...comparendos, ...multas];
            const status = resultados.length === 0 ? 'notfound' : 'ok';

            return res.json({ ok: true, status, data: resultados });
        }

        // Si no interceptamos datos, error
        return res.status(500).json({ ok: false, error: "No se pudo obtener datos del SIMIT" });

    } catch (error) {
        if (browser) await browser.close();
        return res.status(500).json({ ok: false, error: "Error: " + error.message });
    }
});

app.get("/", (req, res) => res.json({ status: "ok", message: "SIMIT Scraper v2" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Scraper v2 en puerto ${PORT}`));
