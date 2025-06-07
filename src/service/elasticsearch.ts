// @ts-ignore
let ES6Client: any, ES7Client: any, ES6ApiResponse: any, ES7ApiResponse: any, ES6RequestParams: any, ES7RequestParams: any;
try {
  const elasticsearch = require('@elastic/elasticsearch');
  ES6Client = elasticsearch.Client;
  ES7Client = elasticsearch.Client;
  ES6ApiResponse = class {};
  ES7ApiResponse = class {};
  ES6RequestParams = { Bulk: {}, CatAliases: {}, CatIndices: {}, IndicesCreate: {}, IndicesDelete: {}, IndicesExistsAlias: {}, IndicesPutAlias: {}, IndicesUpdateAliases: {}, Search: {} };
  ES7RequestParams = { Bulk: {}, CatAliases: {}, CatIndices: {}, IndicesCreate: {}, IndicesDelete: {}, IndicesExistsAlias: {}, IndicesPutAlias: {}, IndicesUpdateAliases: {}, Search: {} };
} catch (e) {
  // Elasticsearch not available, use mock
  ES6Client = class { constructor() {} bulk() {} };
  ES7Client = class { constructor() {} bulk() {} };
  ES6ApiResponse = class {};
  ES7ApiResponse = class {};
  ES6RequestParams = { Bulk: {}, CatAliases: {}, CatIndices: {}, IndicesCreate: {}, IndicesDelete: {}, IndicesExistsAlias: {}, IndicesPutAlias: {}, IndicesUpdateAliases: {}, Search: {} };
  ES7RequestParams = { Bulk: {}, CatAliases: {}, CatIndices: {}, IndicesCreate: {}, IndicesDelete: {}, IndicesExistsAlias: {}, IndicesPutAlias: {}, IndicesUpdateAliases: {}, Search: {} };
}
import { BulkResponse, CatAliasesResponse, CatIndicesResponse, IndicesExistsAliasResponse, NodesInfoResponse, SearchResponse } from 'src/types/elasticsearch';

type ApiResponse<T = any, C = any> = ES6ApiResponse<T, C> | ES7ApiResponse<T, C>;

export default class ElasticsearchClient {
  client: ES6Client | ES7Client;

  constructor(client: ES6Client | ES7Client) {
    this.client = client;
  }

  bulk(params: ES6RequestParams.Bulk & ES7RequestParams.Bulk): Promise<ApiResponse<BulkResponse>> {
    return this.client instanceof ES6Client ? this.client.bulk(params) : this.client.bulk(params);
  }

  cat = {
    aliases: (params: ES6RequestParams.CatAliases & ES7RequestParams.CatAliases): Promise<ApiResponse<CatAliasesResponse>> =>
      this.client instanceof ES6Client ? this.client.cat.aliases(params) : this.client.cat.aliases(params),
    indices: (params: ES6RequestParams.CatIndices & ES7RequestParams.CatIndices): Promise<ApiResponse<CatIndicesResponse>> =>
      this.client instanceof ES6Client ? this.client.cat.indices(params) : this.client.cat.indices(params),
  };

  indices = {
    create: (params: ES6RequestParams.IndicesCreate & ES7RequestParams.IndicesCreate) =>
      this.client instanceof ES6Client ? this.client.indices.create(params) : this.client.indices.create(params),
    delete: (params: ES6RequestParams.IndicesDelete & ES7RequestParams.IndicesDelete) =>
      this.client instanceof ES6Client ? this.client.indices.delete(params) : this.client.indices.delete(params),
    existsAlias: (params: ES6RequestParams.IndicesExistsAlias & ES7RequestParams.IndicesExistsAlias): Promise<ApiResponse<IndicesExistsAliasResponse>> =>
      this.client instanceof ES6Client ? this.client.indices.existsAlias(params) : this.client.indices.existsAlias(params),
    putAlias: (params: ES6RequestParams.IndicesPutAlias & ES7RequestParams.IndicesPutAlias) =>
      this.client instanceof ES6Client ? this.client.indices.putAlias(params) : this.client.indices.putAlias(params),
    updateAliases: (params: ES6RequestParams.IndicesUpdateAliases & ES7RequestParams.IndicesUpdateAliases) =>
      this.client instanceof ES6Client ? this.client.indices.updateAliases(params) : this.client.indices.updateAliases(params),
  };

  nodes = {
    info: (): Promise<ApiResponse<NodesInfoResponse>> => (this.client instanceof ES6Client ? this.client.nodes.info() : this.client.nodes.info()),
  };

  ping() {
    return this.client instanceof ES6Client ? this.client.ping() : this.client.ping();
  }

  search(params: ES6RequestParams.Search & ES7RequestParams.Search): Promise<ApiResponse<SearchResponse>> {
    return this.client instanceof ES6Client ? this.client.search(params) : this.client.search(params);
  }
}
