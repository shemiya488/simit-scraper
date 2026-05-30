// index.js — Consulta directa desde el navegador del usuario
// El usuario tiene IP residencial, el SIMIT no lo bloquea

const SIMIT_URL = "https://consultasimit.fcm.org.co/simit/microservices/estado-cuenta-simit/estadocuenta/consulta";
const TOKEN_URL = "https://civiiv2.civii.co/back-civii/api/v1/auth/widget-token";

const spinnerContainer = document.getElementById('container-spinner');
const spinner = document.getElementById('spinner');

async function obtenerToken() {
    const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Origin': 'https://www.fcm.org.co',
            'Referer': 'https://www.fcm.org.co/'
        },
        body: JSON.stringify({ operation: 'simit' })
    });
    const data = await res.json();
    return data.token;
}

async function consultarSIMIT(documento) {
    const token = await obtenerToken();

    const res = await fetch(SIMIT_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': '*/*',
            'Origin': 'https://www.fcm.org.co',
            'Referer': 'https://www.fcm.org.co/',
            'token': token
        },
        body: JSON.stringify({ filtro: documento })
    });

    if (!res.ok) throw new Error('Error HTTP: ' + res.status);
    return await res.json();
}

document.addEventListener('DOMContentLoaded', function () {
    const form = document.getElementById('formGetEstadoCuenta');
    const overlay = document.getElementById('promoOverlay');
    const btnConsultar = document.getElementById('promoConsultarBtn');
    const btnClose = document.getElementById('promoClose');

    if (overlay) overlay.style.display = 'flex';

    function hidePromo() {
        if (overlay) overlay.style.display = 'none';
    }

    if (btnConsultar) btnConsultar.addEventListener('click', function () {
        hidePromo();
        const i = document.getElementById('txtBusqueda');
        if (i) i.focus();
    });

    if (btnClose) btnClose.addEventListener('click', hidePromo);

    if (form) {
        form.addEventListener('submit', async function (e) {
            e.preventDefault();

            const input = document.getElementById('txtBusqueda');
            const placa = input ? input.value.trim() : '';

            if (!placa) {
                alert('Por favor ingresa un número de identificación o placa.');
                return;
            }

            localStorage.setItem('placa', placa);

            if (spinnerContainer) spinnerContainer.classList.remove('disabled');
            if (spinner) spinner.classList.remove('disabled');

            try {
                const raw = await consultarSIMIT(placa);

                // Normalizar datos
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

                let dataFinal;
                if (acuerdos.length > 0 && comparendos.length === 0 && multas.length === 0) {
                    dataFinal = { ok: true, status: 'ok', tipo: 'acuerdos', data: acuerdos };
                } else {
                    const resultados = [...comparendos, ...multas];
                    if (resultados.length === 0) {
                        if (spinnerContainer) spinnerContainer.classList.add('disabled');
                        if (spinner) spinner.classList.add('disabled');
                        alert('No se encontraron multas o comparendos para el documento ingresado.');
                        return;
                    }
                    dataFinal = { ok: true, status: 'ok', data: resultados };
                }

                localStorage.setItem('data', JSON.stringify(dataFinal));
                window.location.href = '/detail?txtBusqueda=' + encodeURIComponent(placa);

            } catch (error) {
                console.error('Error:', error);
                if (spinnerContainer) spinnerContainer.classList.add('disabled');
                if (spinner) spinner.classList.add('disabled');
                alert('Ocurrió un error al consultar. Intenta de nuevo.');
            }
        });
    }
});
