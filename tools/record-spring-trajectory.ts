import { writeFile } from 'node:fs/promises';
import { runTrajectory } from '../tests/helpers/spring-trajectory';

const output = process.argv[2] ?? 'tests/secondary/spring-trajectory.json';

const record = `{
  "sixtyHz": [
${runTrajectory()
  .map((joint) => `    ${JSON.stringify(joint).replaceAll(',', ', ')}`)
  .join(',\n')}
  ]
}\n`;
await writeFile(output, record);
