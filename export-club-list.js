// export-club-list.js — Lista de miembros del club y regalos, 100 % en vivo desde Shopify.
// Uso:  node export-club-list.js
// Genera data/club-optimum-miembros-<fecha>.xlsx (solo lectura: no modifica nada en la tienda).
require("dotenv").config();
const ExcelJS = require("exceljs");
const { shopifyGraphQL } = require("./shopifyAuth");
const {
  getSubscriptionOrdersForCustomer,
  splitSubOrdersByLine,
  TAG_MT_WOMAN,
  TAG_SA_WOMAN,
  TAG_MT_MEN,
  TAG_SA_MEN,
} = require("./vipClub");

// Etiquetas de regalo por campaña; añade aquí las de campañas futuras.
const GIFT_TAGS = ["club-gift-sent-verano-2026-woman", "club-gift-sent-verano-2026-men"];
const ALL_TAGS = [TAG_MT_WOMAN, TAG_SA_WOMAN, TAG_MT_MEN, TAG_SA_MEN, ...GIFT_TAGS];
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchTaggedCustomers() {
  const q = ALL_TAGS.map((t) => `tag:'${t}'`).join(" OR ");
  const out = new Map();
  let after = null;
  do {
    const d = await shopifyGraphQL(
      `query($q: String!, $after: String) {
         customers(first: 250, query: $q, after: $after) {
           nodes { id email displayName tags }
           pageInfo { hasNextPage endCursor }
         }
       }`,
      { q, after },
    );
    for (const n of d.customers.nodes) out.set(n.id, n);
    after = d.customers.pageInfo.hasNextPage ? d.customers.pageInfo.endCursor : null;
  } while (after);
  return [...out.values()];
}

/** Producto del último pedido de suscripción de una línea ("Optimum - Trimestral"). */
function lastProduct(lineOrders) {
  if (!lineOrders.length) return "—";
  const last = lineOrders[lineOrders.length - 1];
  const item = last.lineItems.nodes.find((i) => i.sellingPlan) || last.lineItems.nodes[0];
  if (!item) return "—";
  const variant = item.variant?.title;
  return variant && variant !== "Default Title" ? `${item.title} - ${variant}` : item.title;
}

(async () => {
  console.log("🔍 Leyendo clientes etiquetados…");
  const customers = await fetchTaggedCustomers();
  console.log(`   ${customers.length} clientes. Leyendo su producto de suscripción (uno a uno)…`);

  const rows = [];
  let i = 0;
  for (const c of customers) {
    const tags = c.tags.map((t) => t.trim());
    let prodW = "—";
    let prodM = "—";
    try {
      const subOrders = await getSubscriptionOrdersForCustomer(c.id);
      const sorted = [...subOrders].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
      const { woman, men } = splitSubOrdersByLine(sorted);
      prodW = lastProduct(woman);
      prodM = lastProduct(men);
    } catch (e) {
      console.warn(`   ⚠️ ${c.email}: ${e.message}`);
    }
    const nivel = (sa, mt) => (tags.includes(sa) ? "Semestral / Anual" : tags.includes(mt) ? "Mensual / Trimestral" : "—");
    rows.push([
      c.email || "—",
      c.displayName || "—",
      nivel(TAG_SA_WOMAN, TAG_MT_WOMAN),
      prodW,
      nivel(TAG_SA_MEN, TAG_MT_MEN),
      prodM,
      tags.includes(GIFT_TAGS[0]) ? "Sí" : "—",
      tags.includes(GIFT_TAGS[1]) ? "Sí" : "—",
    ]);
    if (++i % 25 === 0) console.log(`   ${i}/${customers.length}…`);
    await delay(250);
  }
  rows.sort((a, b) => (a[0] || "").localeCompare(b[0] || ""));

  const hoy = new Date();
  const fecha = hoy.toISOString().slice(0, 10);
  const fechaEs = hoy.toLocaleDateString("es-ES", { timeZone: "Europe/Madrid" });
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Miembros del club");
  const arial = { name: "Arial", size: 10 };
  const note = { name: "Arial", size: 9, italic: true, color: { argb: "FF666666" } };

  ws.getCell("A1").value = "Optimum Club — miembros, productos y regalos";
  ws.getCell("A1").font = { name: "Arial", size: 13, bold: true };
  ws.getCell("A2").value = `Datos leídos en vivo de Shopify el ${fechaEs} (etiquetas y último pedido de suscripción de cada línea).`;
  ws.getCell("A2").font = note;
  ws.getCell("A3").value = "«Regalo Verano 2026» = ya recibió el regalo de esa línea en la campaña (8–30 sep), por la app o por la lista manual previa.";
  ws.getCell("A3").font = note;

  const headers = ["Email", "Nombre", "Club línea Woman", "Producto Woman", "Club línea Men", "Producto Men", "Regalo Verano 2026 · Woman", "Regalo Verano 2026 · Men"];
  const HR = 5;
  headers.forEach((h, idx) => {
    const cell = ws.getRow(HR).getCell(idx + 1);
    cell.value = h;
    cell.font = { name: "Arial", size: 10, bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F2A44" } };
  });
  rows.forEach((row, r) => {
    row.forEach((v, cIdx) => {
      const cell = ws.getRow(HR + 1 + r).getCell(cIdx + 1);
      cell.value = v;
      cell.font = cIdx >= 2 && v === "—" ? { ...arial, color: { argb: "FF999999" } } : arial;
    });
  });
  const last = HR + rows.length;
  ws.autoFilter = `A${HR}:H${last}`;
  ws.views = [{ state: "frozen", ySplit: HR }];
  [34, 28, 19, 34, 19, 34, 23, 21].forEach((w, idx) => (ws.getColumn(idx + 1).width = w));

  const nW = rows.filter((r) => r[2] !== "—").length;
  const nM = rows.filter((r) => r[4] !== "—").length;
  const both = rows.filter((r) => r[2] !== "—" && r[4] !== "—").length;
  const gW = rows.filter((r) => r[6] === "Sí").length;
  const gM = rows.filter((r) => r[7] === "Sí").length;
  const resumen = [
    ["Total clientes en la lista", rows.length],
    ["Miembros línea Woman", nW],
    ["Miembros línea Men", nM],
    ["En ambas líneas", both],
    ["Miembros únicos del club", nW + nM - both],
    ["Premiados que ya no son miembros", rows.length - (nW + nM - both)],
    ["Regalos entregados Woman (app + manual)", gW],
    ["Regalos entregados Men (app + manual)", gM],
  ];
  const S = last + 2;
  ws.getRow(S).getCell(1).value = "Resumen";
  ws.getRow(S).getCell(1).font = { ...arial, bold: true };
  resumen.forEach(([label, val], idx) => {
    ws.getRow(S + 1 + idx).getCell(1).value = label;
    ws.getRow(S + 1 + idx).getCell(1).font = arial;
    ws.getRow(S + 1 + idx).getCell(2).value = val;
    ws.getRow(S + 1 + idx).getCell(2).font = { ...arial, bold: true };
  });
  ws.getRow(S + resumen.length + 2).getCell(1).value = `Valores calculados al generar el archivo (${fechaEs}); la tabla de arriba es la fuente.`;
  ws.getRow(S + resumen.length + 2).getCell(1).font = note;

  const out = `${__dirname}/data/club-optimum-miembros-${fecha}.xlsx`;
  await wb.xlsx.writeFile(out);
  console.log(`\n✅ ${out}`);
  console.log(`   ${rows.length} filas | Woman ${nW} | Men ${nM} | ambas ${both} | únicos ${nW + nM - both} | regalos W ${gW} / M ${gM}`);
})().catch((e) => {
  console.error("Error:", e.message);
  process.exit(1);
});
