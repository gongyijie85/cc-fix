// #101：tsup loader 把 *.html 作为文本打包；为静态导入提供环境类型声明，
// 使 src/gui/server.ts 无需 @ts-ignore。
declare module "*.html" {
  const content: string;
  export default content;
}
