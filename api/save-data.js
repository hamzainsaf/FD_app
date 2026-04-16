import { put } from '@vercel/blob';

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '2mb',
    },
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    console.error('BLOB_READ_WRITE_TOKEN is not set');
    return res.status(500).json({ success: false, error: 'Blob token not configured' });
  }

  try {
    const data = req.body;

    if (!data?.header?.participant_id) {
      return res.status(400).json({ error: 'Missing participant_id in header' });
    }

    const pid       = data.header.participant_id;
    const timestamp = Date.now();

    // Save JSON
    const jsonBlob = await put(
      `${pid}_${timestamp}.json`,
      JSON.stringify(data, null, 2),
      { access: 'public', contentType: 'application/json' }
    );

    // Save CSV alongside it
    const csvContent = trialsToCSV(data.trials || []);
    const csvBlob = await put(
      `${pid}_${timestamp}.csv`,
      csvContent,
      { access: 'public', contentType: 'text/csv' }
    );

    return res.status(200).json({
      success: true,
      url:     jsonBlob.url,
      csvUrl:  csvBlob.url,
    });

  } catch (err) {
    console.error('save-data error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

// Mirror of your frontend trialsToCSV
const CSV_COLS = [
  'subj_idx','rt','rt_ms','response','is_correct','is_anticipatory','status',
  'block_id','block_number','instruction','base_rate','face_ratio',
  'trial_type','stimulus_id','facelikeness',
  'trial_index','global_trial_num','phase',
];

function trialsToCSV(trials) {
  const header = CSV_COLS.join(',');
  const rows   = trials.map((t) =>
    CSV_COLS.map((col) => {
      const v = t[col];
      if (v === null || v === undefined) return '';
      if (typeof v === 'string' && v.includes(',')) return `"${v}"`;
      return v;
    }).join(',')
  );
  return [header, ...rows].join('\n');
}