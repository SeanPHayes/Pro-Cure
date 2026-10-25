import { runService } from '@procure/platform';
import { financeService } from './service.js';

await runService(financeService);
