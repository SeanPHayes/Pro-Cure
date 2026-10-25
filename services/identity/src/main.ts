import { runService } from '@procure/platform';
import { identityService } from './service.js';

await runService(identityService);
