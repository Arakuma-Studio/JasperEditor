// Remotion CLI configuration of the fixture project (the engine runs `remotion bundle` with it, S08:MGC-010).
import { Config } from '@remotion/cli/config';

Config.setEntryPoint('src/index.ts');
// PNG frames keep the alpha channel (JPEG has none).
Config.setVideoImageFormat('png');
