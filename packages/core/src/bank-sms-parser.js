import { toPaise } from '@youpi/common';

/**
 * Intelligent Monetary Amount Extractor for Indian UPI & Bank SMS.
 * Extracts amounts with prefix (Rs. 200, INR 500, ₹50), suffix (20.00 Rs),
 * proximity words ("20.00 received", "credited with 20.00"),
 * or standalone decimal amounts ("20.00").
 * Filters out available balance and credit limit clauses so balance amounts are never confused with payment amounts.
 * @param {string} text
 * @returns {{ amountStr: string, amountPaise: bigint } | null}
 */
export function extractIntelligentAmount(text) {
  if (!text || typeof text !== 'string') return null;

  // 0. Remove balance mentions (e.g. "Avl Bal Rs 10,000", "Bal: INR 5000", "Available limit Rs. 20,000")
  // to avoid extracting account balance instead of credit amount.
  const balancePattern = /(?:(?:avl\b|avail\b|available\b|tot\b|total\b|ledger\b|clear\b|curr\b|current\b)\s*(?:bal\b|balance\b|limit\b)?|bal\b|balance\b)[\s:=-]*(?:(?:rs\b\.?|inr\b)|₹)?[\s:=-]*[\d,]+(?:\.\d{1,2})?/gi;
  const sanitizedText = text.replace(balancePattern, ' ').trim();

  // Pattern 0: Direct credit proximity phrases (e.g. "credited with Rs. 500", "received ₹200.00", "Rs 499.00 credited")
  const directCreditMatch = sanitizedText.match(/(?:credited\s*(?:with|by|for)?|received|deposit(?:ed)?)\s*[:=-]?\s*(?:(?:rs\b\.?|inr\b)|₹)?[\s:=-]*([\d,]+(?:\.\d{1,2})?)/i) ||
    sanitizedText.match(/(?:(?:rs\b\.?|inr\b)|₹)[\s:=-]*([\d,]+(?:\.\d{1,2})?)\s*(?:(?:has\s+been|is)\s+)?(?:credited|received|deposited)/i);
  if (directCreditMatch && (directCreditMatch[1] || directCreditMatch[2])) {
    const clean = (directCreditMatch[1] || directCreditMatch[2]).replace(/,/g, '');
    try {
      return { amountStr: clean, amountPaise: toPaise(clean) };
    } catch {}
  }

  // Pattern 1: Standard currency prefix on sanitized text (e.g. Rs 499, Rs. 499, ₹499, INR 499, Rs. 20.00, ₹1,200.50)
  const prefixMatch = sanitizedText.match(/(?:(?:rs\b\.?|inr\b)|₹)[\s:=-]*([\d,]+(?:\.\d{1,2})?)/i);
  if (prefixMatch && prefixMatch[1]) {
    const clean = prefixMatch[1].replace(/,/g, '');
    try {
      return { amountStr: clean, amountPaise: toPaise(clean) };
    } catch {}
  }

  // Pattern 2: Standard currency suffix on sanitized text (e.g. 499 Rs, 499.00 INR, 20.00 Rs, 20rs, 500 inr)
  const suffixMatch = sanitizedText.match(/(?:^|[^\w.])([\d,]+(?:\.\d{1,2})?)[\s:=-]*(?:(?:rs\b\.?|inr\b)|₹)/i);
  if (suffixMatch && suffixMatch[1]) {
    const clean = suffixMatch[1].replace(/,/g, '');
    try {
      return { amountStr: clean, amountPaise: toPaise(clean) };
    } catch {}
  }

  // Pattern 3: Number adjacent to credit keywords
  const creditProximityMatch = sanitizedText.match(/(?:credited|received|deposit|cr)[\s\w:]*?([\d,]+(?:\.\d{1,2})?)|([\d,]+(?:\.\d{1,2})?)[\s\w:]*?(?:credited|received|deposit|cr)/i);
  if (creditProximityMatch) {
    const rawVal = creditProximityMatch[1] || creditProximityMatch[2];
    if (rawVal) {
      const clean = rawVal.replace(/,/g, '');
      if (/^\d+(\.\d{1,2})?$/.test(clean) && Number(clean) < 10000000 && Number(clean) > 0) {
        try {
          return { amountStr: clean, amountPaise: toPaise(clean) };
        } catch {}
      }
    }
  }

  // Pattern 4: Standalone decimal currency number (e.g. 20.00, 150.50, 449.00)
  const standaloneDecimal = sanitizedText.match(/\b(\d{1,6}\.\d{2})\b/);
  if (standaloneDecimal && standaloneDecimal[1]) {
    const clean = standaloneDecimal[1];
    try {
      return { amountStr: clean, amountPaise: toPaise(clean) };
    } catch {}
  }

  return null;
}

/**
 * Bank and UPI SMS parser for Indian financial institutions:
 * SBI, HDFC, ICICI, Axis, Kotak, PNB, Bank of Baroda, Paytm Payments Bank, PhonePe, GPay, etc.
 */
export class BankSmsParser {
  /**
   * Parses incoming SMS message text.
   * @param {{
   *   text: string,
   *   sender?: string,
   *   timestamp?: Date | number | string
   * }} sms
   * @returns {{
   *   amountPaise: bigint,
   *   amount: string,
   *   bankReferenceNumber?: string,
   *   senderVpa?: string,
   *   observedAt: Date,
   *   rawText: string
   * } | null}
   */
  static parse(sms) {
    // Bank credit SMS are short. Capping the text bounds the cost of the reference-extraction
    // regexes, which are scanned from every start offset and would otherwise let one
    // oversized message block the event loop (ReDoS / DoS).
    const MAX_SCAN_CHARS = 4096;
    const text = (sms.text || '').trim().slice(0, MAX_SCAN_CHARS);
    if (!text) return null;

    // Check if SMS represents an incoming credit. Bare "payment" or "transferred" without credit context is rejected.
    const creditKeywords = /\b(credited|received|deposit|deposited|payment received|money received|added to (?:your )?(?:account|wallet)|upi\/cr)\b/i;
    if (!creditKeywords.test(text)) {
      return null;
    }

    // Reject debit notifications:
    // If debit indicators exist and appear before credit indicators (e.g. "debited ... credited back in 48h")
    // or if the account itself is being debited, reject immediately.
    const debitIdx = text.search(/\b(?:debited|withdrawn|deducted|spent|paid rs|sent rs)\b/i);
    const creditIdx = text.search(/\b(?:credited|received|deposit|deposited)\b/i);
    if (debitIdx !== -1) {
      if (creditIdx === -1 || debitIdx < creditIdx) {
        return null;
      }
      if (/\b(?:debited\s*(?:from|by|for)|is\s+debited|has\s+been\s+debited)\b/i.test(text)) {
        return null;
      }
    }

    // 1. Extract Amount using Intelligent Multi-Pattern Extractor
    const extractedAmount = extractIntelligentAmount(text);
    if (!extractedAmount) {
      return null;
    }

    // 2. Extract Bank Reference / UTR / RRN (including FamPay Transaction IDs)
    let bankRef;
    const utrPatterns = [
      /(?:upi\s*ref(?:erence)?\s*(?:no\.?|num)?|utr(?:\s*no\.?)?|rrn(?:\s*no\.?)?|txn\s*(?:id|ref|#)?|transaction\s*id|ref\s*no\.?)[\s:=-]+([a-zA-Z0-9\-_]{6,35})/i,
      /(?:upi\/(?:[0-9]+\/|cr\/)([a-zA-Z0-9\-_]{6,35}))/i,
      /\b(?:ref(?:\s*(?:no\.?|id|#))?)[:\s#=-]+([a-zA-Z0-9\-_]{6,35})/i,
      /\b([0-9]{12})\b/
    ];

    for (const pat of utrPatterns) {
      const match = text.match(pat);
      if (match && match[1]) {
        bankRef = match[1].trim();
        break;
      }
    }

    // 3. Extract Sender VPA (including FamPay formats like "from Rahul (UPI ID: rahul@fam)")
    let senderVpa;
    const vpaMatch = text.match(/(?:from|by|vpa|upi\s*id)[\s:]+(?:[a-zA-Z\s]+[\(\[])?([a-zA-Z0-9.\-_]{2,64}@[a-zA-Z0-9.\-_]{2,32})/i);
    if (vpaMatch && vpaMatch[1]) {
      senderVpa = vpaMatch[1].trim().replace(/[.,;]+$/, '');
    }

    // 4. Resolve Observation Timestamp
    let observedAt = new Date();
    if (sms.timestamp) {
      const parsed = new Date(sms.timestamp);
      if (!isNaN(parsed.getTime())) {
        observedAt = parsed;
      }
    }

    return {
      amountPaise: extractedAmount.amountPaise,
      amount: extractedAmount.amountStr,
      bankReferenceNumber: bankRef,
      senderVpa,
      observedAt,
      rawText: text
    };
  }
}
