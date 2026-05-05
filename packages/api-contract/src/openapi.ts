import { generateOpenApi } from '@ts-rest/open-api';
import { apiContract } from './contracts';

export const openApiDocument = generateOpenApi(
  apiContract,
  {
    info: {
      title: 'Crowi API',
      description: 'API for Crowi - Markdown-based Wiki Application',
      version: '2.0.0',
    },
    servers: [
      {
        url: 'http://localhost:3000/api/v2',
        description: 'Local development server',
      },
      {
        url: 'https://your-crowi-instance.com/api/v2',
        description: 'Production server',
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'JWT token authentication',
        },
      },
    },
  },
  {
    setOperationId: true,
    jsonQuery: true,
  },
);
