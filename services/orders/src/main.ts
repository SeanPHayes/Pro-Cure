import { runService } from '@procure/platform';
import { ordersService } from './service.js';

await runService(ordersService);
