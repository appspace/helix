import express from 'express';
import cors from 'cors';
import { postConnect, deleteConnect, getStatus } from './routes/connect.js';
import { getSchemas, getSchema } from './routes/schema.js';
import { postQuery } from './routes/query.js';
import { postDeleteRow } from './routes/deleteRow.js';

const app = express();
const PORT = process.env['PORT'] ?? 3001;
const CORS_ORIGIN = process.env['CORS_ORIGIN'] ?? 'http://localhost:5174';

app.use(cors({ origin: CORS_ORIGIN, credentials: true }));
app.use(express.json());

// Connection
app.post('/api/connect', postConnect);
app.delete('/api/connect', deleteConnect);
app.get('/api/connect/status', getStatus);

// Schema
app.get('/api/schemas', getSchemas);
app.get('/api/schema', getSchema);

// Query
app.post('/api/query', postQuery);
app.post('/api/delete-row', postDeleteRow);

app.listen(PORT, () => {
  console.log(`Helix server running at http://localhost:${PORT}`);
});
