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

  const body = req.body;

  // Inject prompt into the last text block
  if (body.messages && body.messages[0] && body.messages[0].content) {
    const content = body.messages[0].content;
    if (Array.isArray(content)) {
      const textBlock = content.find(c => c.type === 'text');
      if (textBlock) textBlock.text = getPrompt(textBlock.text);
    } else if (typeof content === 'string') {
      body.messages[0].content = getPrompt(content);
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

function getPrompt(existingText) {
  const prefix = existingText && existingText.trim() ? existingText + '\n\n' : '';
  return prefix + `IMPORTANT: Your entire response must be a single valid JSON object. Do not write any text before or after the JSON. Do not explain anything. Do not say "I need to". Just output the JSON.

Extract these fields from the contract or BOQ document above:

{
  "client_name": "",
  "contract_number": "",
  "project_name": "",
  "currency": "EUR",
  "payment_terms": "",
  "contract_start_date": "YYYY-MM-DD",
  "contract_end_date": "YYYY-MM-DD",
  "milestones": [
    {"description": "", "amount": "", "due_date": "YYYY-MM-DD"}
  ]
}

Rules:
- client_name: the customer/lessee company name
- contract_number: look in page footers or headers, format like "JX101192023". Empty string if not found.
- project_name: name of the project or publicity event. For BOQ files use the sheet name or quotation title.
- currency: 3-letter code, default EUR
- payment_terms: one-line summary of payment schedule
- contract_start_date / contract_end_date: YYYY-MM-DD, empty string if not found
- milestones: for BOQ files, look for M1/M2/M3/M4 columns or percentage splits in the header row. Use the Grand Total row for amounts. Calculate actual numeric amounts. For contracts, extract each payment obligation including deposits.
- All amount fields must be numeric strings only (e.g. "39480" not "EUR 39,480" or "50%")
- Dates must be YYYY-MM-DD or empty string
- Leave unknown fields as empty string
- Output JSON only. Nothing else.`;
}
