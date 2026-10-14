import { parseErpStockFile } from "./utils/erpSync";
import sajEstoqueData from "./saj_estoque.json";
import autocarEstoqueData from "./autocar_estoque.json";
import valencaEstoqueData from "./valenca_estoque.json";
import centralAutocenterEstoqueData from "./central_autocenter_estoque.json";

// Arquivos do ERP embutidos no app (gerados por tools/estoque-time-sistemas.py).
//
// Módulo próprio para virar um pedaço próprio do build: são ~250 kB de JSON que
// só o administrador usa (botões Sincronizar/Injetar Estoque). Importados de
// forma estática pelo StockTable, eles pesavam na tela de Cadastros e Ajustes de
// todo dono de loja. Agora o StockTable os pede com import() só para o admin.
export const ERP_FILES = {
  saj: parseErpStockFile(sajEstoqueData),
  autocar: parseErpStockFile(autocarEstoqueData),
  valenca: parseErpStockFile(valencaEstoqueData),
  centralAutocenter: parseErpStockFile(centralAutocenterEstoqueData)
};

export type ErpFiles = typeof ERP_FILES;
