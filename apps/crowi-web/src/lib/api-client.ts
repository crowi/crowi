import { initClient } from '@ts-rest/core';
import { apiContract } from '@crowi/api-contract';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

export const apiClient = initClient(apiContract, {
  baseUrl: `${API_BASE_URL}/api/v2`,
  baseHeaders: {},
  // Add Authorization header with access token from localStorage
  api: async ({ path, method, headers, body }) => {
    // Get access token from localStorage (client-side only)
    const accessToken = typeof window !== 'undefined' ? localStorage.getItem('accessToken') : null;

    // Build headers object
    const requestHeaders: HeadersInit = {
      ...headers,
    };

    // Add Authorization header if token exists
    if (accessToken) {
      requestHeaders['Authorization'] = `Bearer ${accessToken}`;
    }

    // Make the fetch request
    const response = await fetch(path, {
      method,
      headers: requestHeaders,
      body: body as BodyInit | undefined,
    });

    // Parse response body based on content-type
    const contentType = response.headers.get('content-type');
    let responseBody;

    if (contentType?.includes('application/json')) {
      responseBody = await response.json();
    } else {
      responseBody = await response.text();
    }

    // Return in the format ts-rest expects
    return {
      status: response.status,
      body: responseBody,
      headers: response.headers,
    };
  },
});
