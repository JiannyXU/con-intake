export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.body.action === 'notify') {
    try {
      await fetch(process.env.LARK_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body.payload)
      });
      return res.status(200).json({ ok: true });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // Inject improved prompt before forwarding to Anthropic
  const body = req.body;
  if (body.messages && body.messages[0] && body.messages[0].content) {
    const content = body.messages[0].content;
    const textBlock = Array.isArray(content)
      ? content.find(c => c.type === 'text')
      : null;
    if (textBlock) {
      textBlock.text = getPrompt();
    }
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body)
  });

  const data = await response.json();
  res.status(response.status).json(data);
}

function getPrompt() {
  return `You are extracting structured data from a rental/service contract. Return ONLY a valid JSON object with no markdown, no explanation, no preamble.

{
  "client_name": "",
  "contract_number": "",
  "project_name": "",
  "contract_amount": "",
  "currency": "EUR",
  "payment_terms": "",
  "contract_start_date": "YYYY-MM-DD",
  "contract_end_date": "YYYY-MM-DD",
  "key_account": "",
  "milestones": [
    {"description": "", "amount": "", "due_date": "YYYY-MM-DD"}
  ]
}

Extraction rules:
- client_name: the Lessee company name (not EventRent/Lessor)
- contract_number: look in page footers, format is usually initials + date digits e.g. "JX101192023". Return exactly as found.
- project_name: the purpose/name of the publicity event or project
- contract_amount: the TOTAL basic + additional charge only (exclude deposit). Numeric string only, no currency symbol, use dot as decimal separator.
- currency: 3-letter code, default EUR
- payment_terms: summarize all payment conditions in one line
- contract_start_date / contract_end_date: from the rental period section, YYYY-MM-DD format
- key_account: leave empty if not found
- milestones: extract EVERY payment obligation as a separate milestone including:
  * Each percentage-based payment (e.g. "50% of basic rental charge at signing")
  * Security deposit if
