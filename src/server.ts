import { config } from './config.js';
import { createApp } from './app.js';

const app = createApp();

app.listen(config.PORT, () => {
  console.log(`LINE dashboard listening on http://localhost:${config.PORT}`);
});
