import { put } from '@vercel/blob';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const data = req.body;
    if (!data || !data.header || !data.header.participant_id) {
      return res.status(400).json({ error: 'Missing participant_id in header' });
    }

    const filename = `${data.header.participant_id}_${Date.now()}.json`;
    const blob = await put(filename, JSON.stringify(data, null, 2), {
      access: 'public',
      contentType: 'application/json',
    });

    return res.status(200).json({ success: true, url: blob.url });
  } catch (err) {
    console.error('save-data error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
