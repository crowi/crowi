const { writeFileSync } = require('fs');
const { join } = require('path');

// We need to build the project first to use the compiled version
const { openApiDocument } = require('../dist/index');

// Convert the OpenAPI document to JSON
const openApiJson = JSON.stringify(openApiDocument, null, 2);

// Write to file
const outputPath = join(__dirname, '..', 'openapi.json');
writeFileSync(outputPath, openApiJson);

console.log(`OpenAPI specification generated at: ${outputPath}`);

// Also generate a YAML version if needed
try {
  const yaml = require('js-yaml');
  const openApiYaml = yaml.dump(openApiDocument);
  const yamlOutputPath = join(__dirname, '..', 'openapi.yaml');
  writeFileSync(yamlOutputPath, openApiYaml);
  console.log(`OpenAPI YAML specification generated at: ${yamlOutputPath}`);
} catch (error) {
  console.log('Skipping YAML generation (install js-yaml to enable)');
}
