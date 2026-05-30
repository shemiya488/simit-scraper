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
            args: [
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu"
            ]
        });

        const page = await browser.newPage();
        await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36");

        await page.goto("https://fcm.org.co/simit/#/estado-cuenta", {
            waitUntil: "networkidle2",
            timeout: 30000
        });

        // Esperar el campo de búsqueda
        await page.waitForSelector("#txtBusqueda, input[type='search'], input[placeholder*='placa'], input[placeholder*='cedula'], input[placeholder*='cédula']", { timeout: 15000 });

        // Llenar el campo
        const input = await page.$("#txtBusqueda") ||
                      await page.$("input[type='search']") ||
                      await page.$("input[placeholder*='placa']") ||
                      await page.$("input[placeholder*='cedula']");

        if (!input) throw new Error("No se encontró el campo de búsqueda");

        await input.click({ clickCount: 3 });
        await input.type(documento, { delay: 50 });

        // Click en buscar
        const btn = await page.$("button[type='submit'], .btn-buscar, #btnBuscar, button.search-btn");
        if (btn) await btn.click();
        else await page.keyboard.press("Enter");

        // Esperar resultados
        await page.waitForFunction(() => {
            const body = document.body.innerText;
            return body.includes("comparendo") || body.includes("multa") ||
                   body.includes("paz y salvo") || body.includes("Paz y Salvo") ||
                   body.includes("No se encontr") || body.includes("acuerdo");
        }, { timeout: 20000 });

        await new Promise(r => setTimeout(r, 2000));

        // Extraer datos de la página
        const resultado = await page.evaluate(() => {
            const body = document.body.innerText;
            const html = document.body.innerHTML;

            // Buscar total a pagar
            const totalMatch = body.match(/\$\s*[\d.,]+/g);
            const pazSalvo = body.toLowerCase().includes("paz y salvo");

            // Buscar tabla de comparendos
            const rows = [];
            document.querySelectorAll("table tr, .comparendo-item, .multa-item").forEach(row => {
                rows.push(row.innerText.trim());
            });

            return {
                texto: body.substring(0, 3000),
                totales: totalMatch || [],
                pazSalvo,
                filas: rows.slice(0, 20)
            };
        });

        await browser.close();

        const status = resultado.pazSalvo ? "notfound" : "ok";

        return res.json({
            ok: true,
            status,
            data: {
                documento,
                pazSalvo: resultado.pazSalvo,
                totales: resultado.totales,
                filas: resultado.filas,
                resumen: resultado.texto.substring(0, 500)
            }
        });

    } catch (error) {
        if (browser) await browser.close();
        return res.status(500).json({
            ok: false,
            error: "Error en scraping: " + error.message
        });
    }
});

app.get("/", (req, res) => res.json({ status: "ok", message: "SIMIT Scraper activo" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Scraper corriendo en puerto ${PORT}`));
