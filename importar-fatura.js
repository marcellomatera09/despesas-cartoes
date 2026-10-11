/* Importação de faturas em PDF (Bradesco/Amex e Inter) — roda 100% no navegador, sem IA e sem API paga.
   Uso:  const r = await processarFatura(file);   // file = <input type="file"> .files[0]
   Retorna { banco, vencimento, totalFatura, somaLida, conferido, lancamentos[], ignorados[] } */

const PDFJS_VERSION = '3.11.174';
const PDFJS_BASE = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/' + PDFJS_VERSION + '/';

function carregarScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Não foi possível carregar o leitor de PDF'));
    document.head.appendChild(s);
  });
}

async function garantirPdfJs() {
  if (typeof pdfjsLib === 'undefined') await carregarScript(PDFJS_BASE + 'pdf.min.js');
  pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_BASE + 'pdf.worker.min.js';
}

/* ---------- utilitários ---------- */
const num = s => parseFloat(String(s).replace(/\./g, '').replace(',', '.'));
const pad = n => String(n).padStart(2, '0');
const isoDeDMY = s => { const [d, m, a] = s.split('/'); return a + '-' + m + '-' + d; };
const arred = v => Math.round(v * 100) / 100;

function extrairParcelaFinal(desc) {            // "HOTMART DecadaMilion11/12" -> parcela 11 de 12
  const p = desc.match(/(\d{2})\/(\d{2})$/);
  if (p) {
    const a = +p[1], t = +p[2];
    if (a >= 1 && t >= 2 && a <= t) return { descricao: desc.slice(0, -5).trim(), parcela: { atual: a, total: t } };
  }
  return { descricao: desc.trim(), parcela: null };
}

/* ---------- leitura do PDF -> linhas de texto ---------- */
async function lerLinhasDoPdf(arrayBuffer, pedirSenha) {
  let senha, pdf;
  for (;;) {
    try {
      pdf = await pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer.slice(0)), password: senha }).promise;
      break;
    } catch (e) {
      if (e && e.name === 'PasswordException') {
        senha = pedirSenha ? pedirSenha(e.code === 2) : null;
        if (!senha) throw new Error('Fatura protegida por senha');
      } else throw e;
    }
  }
  const linhas = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    const itens = tc.items
      .filter(i => i.str && i.str.length)
      .map(i => ({ x: i.transform[4], y: i.transform[5], w: i.width || 0, h: Math.abs(i.height) || 10, s: i.str }));
    const grupos = [];
    for (const it of itens) {
      const g = grupos.find(g => Math.abs(g.y - it.y) <= 2.5);
      if (g) g.itens.push(it); else grupos.push({ y: it.y, itens: [it] });
    }
    grupos.sort((a, b) => b.y - a.y);
    for (const g of grupos) {
      g.itens.sort((a, b) => a.x - b.x);
      let out = '', fimAnt = null;
      for (const it of g.itens) {
        // insere espaço só quando há um vão real entre os itens (alguns PDFs trazem letra por letra)
        if (fimAnt !== null && it.x - fimAnt > 0.2 * it.h && !/\s$/.test(out) && !/^\s/.test(it.s)) out += ' ';
        out += it.s;
        fimAnt = it.x + it.w;
      }
      const t = out.replace(/\s+/g, ' ').trim();
      if (t) linhas.push(t);
    }
  }
  return linhas;
}

/* ---------- Bradesco / Amex ---------- */
function parseBradesco(linhas) {
  // separa lançamentos colados na mesma linha (ex.: "199,9902/09/2026 FARMADORO ...")
  linhas = linhas.flatMap(l => l.replace(/(,\d{2})(\d{2}\/\d{2}\/\d{4})/g, '$1\n$2').split('\n'));
  const texto = linhas.join('\n');
  const venc = texto.match(/VENCIMENTO[\s\S]{0,120}?(\d{2}\/\d{2}\/\d{4})/i);
  const tot = texto.match(/TOTAL DA FATURA EM REAL\s+([\d.]+,\d{2})/i) || texto.match(/TOTAL DA FATURA\s+R\$\s*([\d.]+,\d{2})/i);

  let nome = null, titular = null, final = null, fim = false;
  const lancamentos = [], ignorados = [];

  for (const linha of linhas) {
    if (/^RESUMO DAS DESPESAS/i.test(linha)) fim = true;
    if (fim) continue;

    const nm = linha.match(/^([A-ZÀ-Ú][A-ZÀ-Ú ]+?)\s+-\s+[A-Z]/);
    if (nm && !/^\d/.test(linha)) nome = nm[1].trim();
    const cm = linha.match(/X{4}\.X{6}\.X(\d{4})/);
    if (cm) { final = cm[1]; titular = nome; continue; }

    const m = linha.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(.+)$/);
    if (!m || !final) continue;

    let desc, valor, orig = null;
    const cheio = m[4].match(/^(.*?)\s+([\d.]+,\d{2})(?:\s+([A-Z]{3}))?\s+([\d.]+,\d{2})\s+[\d.]+,\d{4}\s+(-?[\d.]+,\d{2})$/);
    if (cheio) {
      desc = cheio[1];
      valor = num(cheio[5]);
      if (cheio[3] && num(cheio[2]) > 0) orig = { moeda: cheio[3], valor: num(cheio[2]) };
    } else {
      const s = m[4].match(/^(.*?)\s+(-?[\d.]+,\d{2})$/);
      if (!s) continue;
      desc = s[1];
      valor = num(s[2]);
    }

    const base = {
      data: m[3] + '-' + m[2] + '-' + m[1],
      cartaoFinal: final,
      titular
    };
    if (/^(PAG BOLETO|PAGTO|PAGAMENTO)/i.test(desc)) {
      ignorados.push({ ...base, descricao: desc.trim(), valor, motivo: 'pagamento da fatura anterior' });
      continue;
    }
    const { descricao, parcela } = extrairParcelaFinal(desc);
    const l = { ...base, descricao, valor, parcela };
    if (orig) { l.moedaOriginal = orig.moeda; l.valorOriginal = orig.valor; }
    lancamentos.push(l);
  }
  return fechar('bradesco', venc && venc[1], tot && num(tot[1]), lancamentos, ignorados);
}

/* ---------- Inter ---------- */
const MESES = { jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6, jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12 };

function parseInter(linhas) {
  const texto = linhas.join('\n');
  const venc = texto.match(/Data de Vencimento\s+(\d{2}\/\d{2}\/\d{4})/i) || texto.match(/VENCIMENTO[\s\S]{0,80}?(\d{2}\/\d{2}\/\d{4})/i);
  const tot = texto.match(/Total CART[ÃA]O\s+\d{4}\*+\d{4}\s+R\$\s*([\d.]+,\d{2})/i);
  const ih = linhas.findIndex(l => /^\d{4}\*+\d{4}/.test(l));
  const titular = ih > 0 && /^[A-ZÀ-Ú ]{6,}$/.test(linhas[ih - 1]) ? linhas[ih - 1] : null;

  let final = null;
  const lancamentos = [], ignorados = [];
  for (const linha of linhas) {
    const cm = linha.match(/^CART[ÃA]O\s+\d{4}\*+(\d{4})/i);
    if (cm) { final = cm[1]; continue; }

    const m = linha.match(/^(\d{1,2}) de ([a-zç]{3})\.? (\d{4})\s+(.+?)\s+-\s+(\+\s*)?R\$\s*([\d.]+,\d{2})$/i);
    if (!m || !MESES[m[2].toLowerCase()]) continue;

    const base = {
      data: m[3] + '-' + pad(MESES[m[2].toLowerCase()]) + '-' + pad(+m[1]),
      cartaoFinal: final,
      titular
    };
    let desc = m[4].trim();
    const credito = !!m[5];
    let valor = num(m[6]);
    if (credito) valor = -valor;

    if (credito && /^(PAGTO|PAGAMENTO)/i.test(desc)) {
      ignorados.push({ ...base, descricao: desc, valor, motivo: 'pagamento da fatura anterior' });
      continue;
    }
    let parcela = null;
    const pm = desc.match(/\(Parcela\s+(\d+)\s+de\s+(\d+)\)/i);
    if (pm) {
      parcela = { atual: +pm[1], total: +pm[2] };
      desc = desc.replace(pm[0], '').trim();
    }
    lancamentos.push({ ...base, descricao: desc, valor, parcela });
  }
  return fechar('inter', venc && venc[1], tot && num(tot[1]), lancamentos, ignorados);
}

/* ---------- comum ---------- */
function fechar(banco, vencDMY, totalFatura, lancamentos, ignorados) {
  const somaLida = arred(lancamentos.reduce((s, l) => s + l.valor, 0));
  const ts = Date.now();
  lancamentos.forEach((l, i) => { l.id = String(ts) + '_' + i; });   // ID sempre string
  return {
    banco,
    vencimento: vencDMY ? isoDeDMY(vencDMY) : null,
    totalFatura: totalFatura == null ? null : totalFatura,
    somaLida,
    conferido: totalFatura != null && Math.abs(somaLida - totalFatura) < 0.015,
    lancamentos,
    ignorados
  };
}

function interpretarFatura(linhas) {
  const texto = linhas.join('\n');
  if (/bradesco/i.test(texto) && /Hist[óo]rico de Lan[çc]amentos/i.test(texto)) return parseBradesco(linhas);
  if (/Despesas da fatura/i.test(texto) && /inter/i.test(texto)) return parseInter(linhas);
  throw new Error('Formato de fatura não reconhecido (suportados: Bradesco/Amex e Inter)');
}

async function processarFatura(file) {
  if (!file || (file.type && file.type !== 'application/pdf')) throw new Error('Selecione um arquivo PDF');
  await garantirPdfJs();
  const buf = await file.arrayBuffer();
  const linhas = await lerLinhasDoPdf(buf, errada =>
    prompt(errada ? 'Senha incorreta. Digite novamente:' : 'Este PDF tem senha. Digite a senha (geralmente os primeiros dígitos do CPF):'));
  return interpretarFatura(linhas);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { lerLinhasDoPdf, interpretarFatura, parseBradesco, parseInter };
}
