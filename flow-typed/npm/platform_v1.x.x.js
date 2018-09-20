// flow-typed signature: 6648a056a689eef7aec084f82dfa3305
// flow-typed version: da30fe6876/platform_v1.x.x/flow_>=v0.25.x

declare module 'platform' {
  declare class Platform extends Object {
    toString(): string;
    parse(userAgent: string): Platform;
    description: ?string;
    layout: ?string;
    manufacturer: ?string;
    name: ?string;
    prerelease: ?string;
    product: ?string;
    ua: ?string;
    version: ?string;
    os: {
      toString(): string,
      architecture: ?number,
      version: ?string,
      family: ?string,
    };
  }
  declare module.exports: Platform
}
