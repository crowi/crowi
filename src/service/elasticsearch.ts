// @ts-ignore
let ES6Client: any, ES7Client: any, ES6ApiResponse: any, ES7ApiResponse: any, ES6RequestParams: any, ES7RequestParams: any;
try {
  const elasticsearch = require('@elastic/elasticsearch');
  ES6Client = elasticsearch.Client;
  ES7Client = elasticsearch.Client;
  ES6ApiResponse = class {};
  ES7ApiResponse = class {};
  ES6RequestParams = {
    Bulk: {},
    CatAliases: {},
    CatIndices: {},
    IndicesCreate: {},
    IndicesDelete: {},
    IndicesExistsAlias: {},
    IndicesPutAlias: {},
    IndicesUpdateAliases: {},
    Search: {},
  };
  ES7RequestParams = {
    Bulk: {},
    CatAliases: {},
    CatIndices: {},
    IndicesCreate: {},
    IndicesDelete: {},
    IndicesExistsAlias: {},
    IndicesPutAlias: {},
    IndicesUpdateAliases: {},
    Search: {},
  };
} catch (e) {
  // Elasticsearch not available, use mock
  ES6Client = class {
    constructor() {}
    bulk() {}
  };
  ES7Client = class {
    constructor() {}
    bulk() {}
  };
  ES6ApiResponse = class {};
  ES7ApiResponse = class {};
  ES6RequestParams = {
    Bulk: {},
    CatAliases: {},
    CatIndices: {},
    IndicesCreate: {},
    IndicesDelete: {},
    IndicesExistsAlias: {},
    IndicesPutAlias: {},
    IndicesUpdateAliases: {},
    Search: {},
  };
  ES7RequestParams = {
    Bulk: {},
    CatAliases: {},
    CatIndices: {},
    IndicesCreate: {},
    IndicesDelete: {},
    IndicesExistsAlias: {},
    IndicesPutAlias: {},
    IndicesUpdateAliases: {},
    Search: {},
  };
}
import { BulkResponse, CatAliasesResponse, CatIndicesResponse, IndicesExistsAliasResponse, NodesInfoResponse, SearchResponse } from 'src/types/elasticsearch';

type ApiResponse<T = any, C = any> = any;

export default class ElasticsearchClient {
  client: any;

  constructor(client: any) {
    this.client = client;
  }

  bulk(params: any): Promise<ApiResponse<BulkResponse>> {
    return this.client.bulk(params);
  }

  cat = {
    aliases: (params: any): Promise<ApiResponse<CatAliasesResponse>> => this.client.cat.aliases(params),
    indices: (params: any): Promise<ApiResponse<CatIndicesResponse>> => this.client.cat.indices(params),
  };

  indices = {
    create: (params: any) => this.client.indices.create(params),
    delete: (params: any) => this.client.indices.delete(params),
    existsAlias: (params: any): Promise<ApiResponse<IndicesExistsAliasResponse>> => this.client.indices.existsAlias(params),
    putAlias: (params: any) => this.client.indices.putAlias(params),
    updateAliases: (params: any) => this.client.indices.updateAliases(params),
  };

  nodes = {
    info: (): Promise<ApiResponse<NodesInfoResponse>> => this.client.nodes.info(),
  };

  ping() {
    return this.client.ping();
  }

  search(params: any): Promise<ApiResponse<SearchResponse>> {
    return this.client.search(params);
  }
}
