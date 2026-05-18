function toSpanishWords(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 1999) return String(n);
  if (n === 0) return "cero";
  const ones = [
    "", "uno", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve",
    "diez", "once", "doce", "trece", "catorce", "quince",
    "dieciséis", "diecisiete", "dieciocho", "diecinueve",
  ];
  const tens = ["", "", "veinte", "treinta", "cuarenta", "cincuenta", "sesenta", "setenta", "ochenta", "noventa"];
  const hundreds = [
    "", "cien", "doscientos", "trescientos", "cuatrocientos", "quinientos",
    "seiscientos", "setecientos", "ochocientos", "novecientos",
  ];
  const veinti = [
    "", "veintiuno", "veintidós", "veintitrés", "veinticuatro", "veinticinco",
    "veintiséis", "veintisiete", "veintiocho", "veintinueve",
  ];
  if (n <= 19) return ones[n];
  if (n <= 29) return n === 20 ? "veinte" : veinti[n - 20];
  if (n < 100) {
    const t = Math.floor(n / 10), u = n % 10;
    return u === 0 ? tens[t] : `${tens[t]} y ${ones[u]}`;
  }
  if (n === 100) return "cien";
  if (n < 200) return `ciento ${toSpanishWords(n - 100)}`;
  if (n < 1000) {
    const h = Math.floor(n / 100), rest = n % 100;
    return rest === 0 ? hundreds[h] : `${hundreds[h]} ${toSpanishWords(rest)}`;
  }
  if (n === 1000) return "mil";
  return `mil ${toSpanishWords(n - 1000)}`;
}

function toIndonesianWords(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 9999) return String(n);
  if (n === 0) return "nol";
  const ones = ["", "satu", "dua", "tiga", "empat", "lima", "enam", "tujuh", "delapan", "sembilan", "sepuluh"];
  if (n <= 10) return ones[n];
  if (n === 11) return "sebelas";
  if (n < 20) return `${ones[n - 10]} belas`;
  if (n < 100) {
    const t = Math.floor(n / 10), u = n % 10;
    return u === 0 ? `${ones[t]} puluh` : `${ones[t]} puluh ${ones[u]}`;
  }
  if (n === 100) return "seratus";
  if (n < 200) return `seratus ${toIndonesianWords(n - 100)}`;
  if (n < 1000) {
    const h = Math.floor(n / 100), rest = n % 100;
    return rest === 0 ? `${ones[h]} ratus` : `${ones[h]} ratus ${toIndonesianWords(rest)}`;
  }
  if (n === 1000) return "seribu";
  if (n < 2000) {
    const rest = n - 1000;
    return rest === 0 ? "seribu" : `seribu ${toIndonesianWords(rest)}`;
  }
  const k = Math.floor(n / 1000), rest = n % 1000;
  return rest === 0 ? `${ones[k]} ribu` : `${ones[k]} ribu ${toIndonesianWords(rest)}`;
}

// Normalizes number digits and currency symbols to their word equivalents so that
// "5 dólares", "$5", and "cinco dólares" all compare equal after normalization.
// Apply this BEFORE other normalization steps (lowercase, accent-strip, etc.).
export function normalizeNumberTokens(text: string, langCode: string): string {
  const toWords = langCode === "id" ? toIndonesianWords : toSpanishWords;
  let s = text;

  // H:MM time format → word form (e.g. "6:00" → "seis", "6:30" → "seis treinta")
  s = s.replace(/\b(\d{1,2}):(\d{2})\b/g, (orig, h, m) => {
    const hour = parseInt(h, 10);
    const min = parseInt(m, 10);
    if (hour > 23 || min > 59) return orig;
    const hourWord = toWords(hour);
    return min === 0 ? hourWord : `${hourWord} ${toWords(min)}`;
  });

  if (langCode !== "id") {
    // $N → word + dólar(es)
    s = s.replace(/\$\s*(\d{1,4})(?!\d)/g, (_, d) => {
      const n = parseInt(d, 10);
      const words = n <= 1000 ? toWords(n) : d;
      return n === 1 ? `${words} dólar` : `${words} dólares`;
    });
  }

  // N% → word + por ciento / persen
  const pct = langCode === "id" ? "persen" : "por ciento";
  s = s.replace(/(\d{1,4})(?!\d)\s*%/g, (_, d) => {
    const n = parseInt(d, 10);
    return `${n <= 1000 ? toWords(n) : d} ${pct}`;
  });

  // remaining standalone digit sequences → words (skip numbers > 1000)
  s = s.replace(/\b(\d{1,4})\b/g, (_, d) => {
    const n = parseInt(d, 10);
    return n <= 1000 ? toWords(n) : d;
  });

  // Spanish: normalize "un"/"una" → "uno" so "1 dólar" and "un dólar" compare equal
  if (langCode !== "id") {
    s = s.replace(/\bun\b/gi, "uno").replace(/\buna\b/gi, "uno");
  }

  return s;
}
