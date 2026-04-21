import express from 'express';
import cors from 'cors';
import { postConnect, deleteConnect, getStatus } from './routes/connect.js';
import { getSchemas, getSchema } from './routes/schema.js';
import { postQuery } from './routes/query.js';

const app = express();
const PORT = process.env['PORT'] ?? 3001;

app.use(cors({ origin: 'http://localhost:5173', credentials: true }));
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

app.listen(PORT, () => {
  console.log(`Helix server running at http://localhost:${PORT}`);
});
