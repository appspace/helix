import express from 'express';
import cors from 'cors';
import { join } from 'path';
import { postConnect, deleteConnect, getStatus, postTestConnect } from './routes/connect.js';
import { getSchemas, getSchema } from './routes/schema.js';
import { postQuery } from './routes/query.js';
import { postDeleteRow } from './routes/deleteRow.js';
import { postUpdateCell } from './routes/updateCell.js';
import { postInsertRow } from './routes/insertRow.js';
import { getTableDdl } from './routes/tableDdl.js';
import { postDropTable } from './routes/dropTable.js';
import { getMcpStatus, postMcpWrites } from './routes/mcpSettings.js';
import { mcpHandler } from './mcp.js';

const app = express();
const PORT = process.env['PORT'] ?? 3001;
const CORS_ORIGIN = process.env['CORS_ORIGIN'] ?? 'http://localhost:5174';

app.use(cors({ origin: CORS_ORIGIN, credentials: true }));
app.use(express.json());

// Connection
app.post('/api/connect', postConnect);
app.post('/api/connect/test', postTestConnect);
app.delete('/api/connect', deleteConnect);
app.get('/api/connect/status', getStatus);

// Schema
app.get('/api/schemas', getSchemas);
app.get('/api/schema', getSchema);
app.get('/api/table-ddl', getTableDdl);

// Query
app.post('/api/query', postQuery);
app.post('/api/delete-row', postDeleteRow);
app.post('/api/update-cell', postUpdateCell);
app.post('/api/insert-row', postInsertRow);
app.post('/api/drop-table', postDropTable);

// MCP
app.get('/api/mcp/status', getMcpStatus);
app.post('/api/mcp/writes', postMcpWrites);
app.post('/mcp', mcpHandler);
app.get('/mcp', mcpHandler);
app.delete('/mcp', mcpHandler);

// Serve the Vite frontend in Electron production builds
const staticPath = process.env['STATIC_PATH'];
if (staticPath) {
  app.use(express.static(staticPath));
  app.get('*', (_req, res) => res.sendFile(join(staticPath, 'index.html')));
}

app.listen(PORT, () => {
  console.log(`Helix server running at http://localhost:${PORT}`);
  console.log(`MCP endpoint:        http://localhost:${PORT}/mcp`);
});
