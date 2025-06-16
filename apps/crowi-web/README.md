# Crowi Web - API Unit Test Tool

This is a minimal web application for testing the Crowi API server endpoints.

## Features

- Test any HTTP method (GET, POST, PUT, DELETE, PATCH)
- Add custom headers
- Send JSON request bodies
- View formatted JSON responses
- See response status codes and timing

## Getting Started

1. Start the API server (from the root directory):
   ```bash
   pnpm dev:api
   ```

2. Start the web server (from the root directory):
   ```bash
   pnpm dev:web
   ```

3. Open your browser to http://localhost:4321

4. Click on "API Unit Test Tool" to access the testing interface

## Using the API Test Tool

1. **Select HTTP Method**: Choose from GET, POST, PUT, DELETE, or PATCH
2. **Enter URL**: The full URL of the API endpoint (e.g., `http://localhost:3000/api/v2/login`)
3. **Add Headers**: Click "+ Add Header" to add custom headers (Content-Type is pre-filled)
4. **Request Body**: For non-GET requests, enter the JSON body
5. **Send Request**: Click "Send Request" to execute the API call
6. **View Response**: The response will appear on the right with status code and formatted JSON

## Example API Calls

### Test Login Endpoint
- Method: `GET`
- URL: `http://localhost:3000/api/v2/login`

### Test Application Status
- Method: `GET`
- URL: `http://localhost:3000/api/v2/installer`

### Test Login (POST)
- Method: `POST`
- URL: `http://localhost:3000/api/v2/login`
- Body:
  ```json
  {
    "loginForm": {
      "email": "test@example.com",
      "password": "password123"
    }
  }
  ```

## Development

This tool is built with Astro and uses vanilla JavaScript for simplicity. The main files are:

- `/src/pages/api-test.astro` - The API testing interface
- `/src/layouts/Layout.astro` - The base layout
- `/src/pages/index.astro` - The home page with links to tools
