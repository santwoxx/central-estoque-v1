import React, { useState, useEffect } from "react";
import { 
  collection, 
  onSnapshot, 
  addDoc, 
  updateDoc, 
  deleteDoc, 
  doc, 
  query, 
  getDocs, 
  where,
  limit,
  serverTimestamp,
  writeBatch
} from "firebase/firestore";
import { db } from "../firebase";
import { UserCredential, UserRole, Company } from "../types";
import { 
  Users, 
  UserPlus, 
  Trash2, 
  Edit, 
  ShieldCheck, 
  Mail, 
  Key, 
  Shield, 
  AlertCircle, 
  Check, 
  X, 
  Search,
  Building,
  Plus,
  Briefcase,
  Loader2,
  Upload,
  AlertTriangle,
} from "lucide-react";

interface UsersAdminProps {
  // Companies are already streamed in real time by App.tsx and shared across every
  // tab that needs them — passed down here instead of opening a second onSnapshot
  // listener on the same "companies" collection (which duplicated every read while
  // this tab was open).
  companies: Company[];

  // Quem abriu a tela. O ADMIN vê tudo (operadores, empresas, backup). O DONO DA
  // EMPRESA (alimentador) abre a mesma tela reduzida a uma única função: cadastrar
  // os VENDEDORES da própria loja. Ele nunca vê credencial de outra empresa, nem
  // a de outro dono, nem os painéis de empresas/backup — e as regras do Firestore
  // repetem cada um desses limites do lado do servidor, então esconder o botão
  // aqui é conveniência, não é a trava.
  currentUser: { role: UserRole; companyId?: string; companyName?: string };
}

export default function UsersAdmin({ companies, currentUser }: UsersAdminProps) {
  // Modo "dono da empresa": tela enxuta, travada na própria loja e no papel Vendedor.
  const isAdminView = currentUser.role === "admin";
  const ownerCompanyId = currentUser.companyId || "";
  const ownerCompanyName =
    companies.find(c => c.id === ownerCompanyId)?.name || currentUser.companyName || "";
  const [credentials, setCredentials] = useState<UserCredential[]>([]);
  const [loading, setLoading] = useState(true);
  // Uma leitura recusada pelo banco devolve lista vazia, que na tela é idêntica a
  // "ainda não cadastrei ninguém". São coisas muito diferentes: sem esta mensagem
  // o dono acharia que perdeu os vendedores dele.
  const [listError, setListError] = useState("");
  const [searchQuery, setSearchQuery] = useState("");

  // Sub tab: credentials list, companies register or backup panel.
  // O dono da empresa só tem a primeira — as outras nem são renderizadas.
  const [subTab, setSubTab] = useState<"credentials" | "companies" | "backup">("credentials");

  // Create/Edit Operator state
  const [showModal, setShowModal] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [selectedId, setSelectedId] = useState("");

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<UserRole>(isAdminView ? "alimentador" : "vendedor");
  const [associatedEmail, setAssociatedEmail] = useState("");
  const [selectedCompanyId, setSelectedCompanyId] = useState("");

  // Create Company state
  const [newCompanyName, setNewCompanyName] = useState("");
  const [newCompanyDesc, setNewCompanyDesc] = useState("");
  const [isEditingCompany, setIsEditingCompany] = useState(false);
  const [editingCompanyId, setEditingCompanyId] = useState("");

  // Backup & Restore State
  const [exporting, setExporting] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoreConfirmText, setRestoreConfirmText] = useState("");
  const [wiping, setWiping] = useState(false);
  const [wipeConfirmText, setWipeConfirmText] = useState("");
  const [backupFile, setBackupFile] = useState<File | null>(null);

  const handleOpenEditCompany = (comp: Company) => {
    setIsEditingCompany(true);
    setEditingCompanyId(comp.id);
    setNewCompanyName(comp.name);
    setNewCompanyDesc(comp.description || "");
    setCompFormError("");
    setCompSuccessMsg("");
  };

  const handleCancelEditCompany = () => {
    setIsEditingCompany(false);
    setEditingCompanyId("");
    setNewCompanyName("");
    setNewCompanyDesc("");
    setCompFormError("");
    setCompSuccessMsg("");
  };

  const [formError, setFormError] = useState("");
  const [successMsg, setSuccessMsg] = useState("");
  
  const [compFormError, setCompFormError] = useState("");
  const [compSuccessMsg, setCompSuccessMsg] = useState("");

  const handleAutoSeedDefaultData = async () => {
    if (window.confirm("Deseja inicializar as empresas padrão (Central Autocar, Central autocenter, Saj pneus) e seus respectivos operadores (isaac, Jorge, Davi) com senhas padrão?")) {
      try {
        const targetCompanies = [
          { name: "Central Autocar", desc: "Filial Central Autocar" },
          { name: "Central autocenter", desc: "Filial Central autocenter" },
          { name: "Saj pneus", desc: "Filial Saj pneus" }
        ];

        const resolvedCompanies: Record<string, string> = {};

        for (const comp of targetCompanies) {
          const matched = companies.find(c => c.name.toLowerCase() === comp.name.toLowerCase());
          let id = "";
          if (!matched) {
            const docRef = await addDoc(collection(db, "companies"), {
              name: comp.name,
              description: comp.desc,
              createdAt: serverTimestamp()
            });
            id = docRef.id;
          } else {
            id = matched.id;
          }
          resolvedCompanies[comp.name] = id;
        }

        const targetUsers = [
          { username: "isaac", password: "isaac1227", displayName: "Isaac", role: "alimentador" as UserRole, companyName: "Central Autocar" },
          { username: "jorge", password: "jorge1227", displayName: "Jorge", role: "alimentador" as UserRole, companyName: "Central autocenter" },
          { username: "davi", password: "davi1227", displayName: "Davi", role: "alimentador" as UserRole, companyName: "Saj pneus" },
          { username: "nicolas", password: "1227", displayName: "Nicolas", role: "alimentador" as UserRole, companyName: "Central autocenter" },
          { username: "edgar", password: "0976", displayName: "Edgar", role: "alimentador" as UserRole, companyName: "Saj pneus" }
        ];

        let createdCount = 0;
        for (const u of targetUsers) {
          const matched = credentials.find(c => c.username.toLowerCase() === u.username.toLowerCase());
          if (!matched) {
            const companyId = resolvedCompanies[u.companyName];
            await addDoc(collection(db, "custom_credentials"), {
              username: u.username,
              password: u.password,
              displayName: u.displayName,
              role: u.role,
              associatedEmail: "",
              companyId,
              companyName: u.companyName,
              createdAt: serverTimestamp()
            });
            createdCount++;
          }
        }

        alert(`Inicialização concluída! Criado ${createdCount} novos usuários e filiais ausentes.`);
      } catch (err: any) {
        console.error(err);
        alert(`Erro ao inicializar dados padrão: ${err.message}`);
      }
    }
  };


  const handleWipeSystem = async (e: React.FormEvent) => {
    e.preventDefault();
    if (wipeConfirmText.trim().toUpperCase() !== "PRODUCAO") {
      alert("Por favor, digite a palavra 'PRODUCAO' para confirmar a ação.");
      return;
    }

    if (!window.confirm("ATENÇÃO MÁXIMA: Esta ação irá excluir TODOS os dados de estoque, movimentações e transferências. As empresas, usuários e senhas serão MANTIDOS. Tem certeza absoluta?")) {
      return;
    }

    setWiping(true);
    try {
      const batchDelete = async (collectionName: string) => {
        const snap = await getDocs(collection(db, collectionName));
        const deleteBatch = writeBatch(db);
        snap.forEach(d => {
          deleteBatch.delete(d.ref);
        });
        await deleteBatch.commit();
      };

      await batchDelete("stock");
      await batchDelete("movements");
      await batchDelete("transfers");

      alert("Sistema limpo com sucesso! O ambiente está pronto para produção.");
      window.location.reload();
    } catch (err: any) {
      console.error("Wipe failed:", err);
      alert("Falha ao limpar o sistema: " + err.message);
    } finally {
      setWiping(false);
    }
  };

  // Export all Firestore data to JSON
  const handleExportBackup = async () => {
    setExporting(true);
    try {
      // 1. Fetch all stock items
      const stockSnap = await getDocs(collection(db, "stock"));
      const stockData: any[] = [];
      stockSnap.forEach(docSnap => {
        stockData.push({ id: docSnap.id, ...docSnap.data() });
      });

      // 2. Fetch all movements
      const movementsSnap = await getDocs(collection(db, "movements"));
      const movementsData: any[] = [];
      movementsSnap.forEach(docSnap => {
        movementsData.push({ id: docSnap.id, ...docSnap.data() });
      });

      // 3. Fetch companies and credentials
      const companiesData = companies.map(c => ({ id: c.id, name: c.name, description: c.description || "" }));
      const credentialsData = credentials.map(c => ({
        id: c.id,
        username: c.username,
        password: c.password,
        displayName: c.displayName,
        role: c.role,
        associatedEmail: c.associatedEmail || "",
        companyId: c.companyId || "",
        companyName: c.companyName || ""
      }));

      // Create backup payload
      const backupObj = {
        backupVersion: "2.0",
        exportedAt: new Date().toISOString(),
        companies: companiesData,
        custom_credentials: credentialsData,
        stock: stockData,
        movements: movementsData
      };

      // Trigger browser download
      const blob = new Blob([JSON.stringify(backupObj, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `central-stoque-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (err: any) {
      console.error("Backup export failed:", err);
      alert("Erro ao exportar backup: " + err.message);
    } finally {
      setExporting(false);
    }
  };

  // Restore database from JSON backup file
  const handleRestoreBackup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!backupFile) return;
    if (restoreConfirmText.trim().toUpperCase() !== "RESTAURAR") {
      alert("Por favor, digite a palavra 'RESTAURAR' para confirmar a ação.");
      return;
    }

    if (!window.confirm("ATENÇÃO MÁXIMA: Esta ação irá excluir TODOS os dados atuais do estoque, filiais e operadores e substituí-los pelo backup. Tem certeza absoluta?")) {
      return;
    }

    setRestoring(true);
    try {
      const fileText = await backupFile.text();
      const backupData = JSON.parse(fileText);

      // Validate JSON structure
      if (!backupData.stock || !backupData.companies || !backupData.custom_credentials) {
        throw new Error("O arquivo selecionado não é um backup válido do Central Stoque.");
      }

      // 1. Delete all current documents in collections
      const batchDelete = async (collectionName: string) => {
        const snap = await getDocs(collection(db, collectionName));
        const deleteBatch = writeBatch(db);
        snap.forEach(d => {
          deleteBatch.delete(d.ref);
        });
        await deleteBatch.commit();
      };

      await batchDelete("stock");
      await batchDelete("companies");
      await batchDelete("custom_credentials");
      await batchDelete("movements");

      // 2. Insert backup documents in chunks of 450 (due to Firestore 500-op batch limit)
      const allWrites: { ref: any, data: any }[] = [];

      // Add Companies
      backupData.companies.forEach((c: any) => {
        allWrites.push({
          ref: doc(db, "companies", c.id),
          data: { name: c.name, description: c.description || "", createdAt: serverTimestamp() }
        });
      });

      // Add Credentials
      backupData.custom_credentials.forEach((c: any) => {
        allWrites.push({
          ref: doc(db, "custom_credentials", c.id),
          data: {
            username: c.username,
            password: c.password,
            displayName: c.displayName,
            role: c.role,
            associatedEmail: c.associatedEmail || "",
            companyId: c.companyId || "",
            companyName: c.companyName || "",
            createdAt: serverTimestamp()
          }
        });
      });

      // Add Stock Items
      backupData.stock.forEach((item: any) => {
        const { id, ...rest } = item;
        allWrites.push({
          ref: doc(db, "stock", id),
          data: {
            ...rest,
            updatedAt: serverTimestamp()
          }
        });
      });

      // Add Movements
      if (backupData.movements) {
        backupData.movements.forEach((m: any) => {
          const { id, ...rest } = m;
          allWrites.push({
            ref: doc(db, "movements", id),
            data: {
              ...rest
            }
          });
        });
      }

      // Execute writes in batches of 450
      for (let i = 0; i < allWrites.length; i += 450) {
        const chunk = allWrites.slice(i, i + 450);
        const writeBatchObj = writeBatch(db);
        chunk.forEach(w => {
          writeBatchObj.set(w.ref, w.data);
        });
        await writeBatchObj.commit();
      }

      alert("Backup restaurado com sucesso! O sistema será recarregado.");
      window.location.reload();
    } catch (err: any) {
      console.error("Restore failed:", err);
      alert("Falha ao restaurar o backup: " + err.message);
    } finally {
      setRestoring(false);
    }
  };

  // Fetch credentials in real-time.
  //
  // O admin varre a coleção inteira. O dono da empresa consulta com os DOIS
  // filtros que a regra do Firestore exige (`role == vendedor` e a empresa dele):
  // sem eles o servidor derruba a consulta inteira, porque não consegue provar
  // que o resultado não traria credencial — e senha — de outra empresa.
  useEffect(() => {
    if (!isAdminView && !ownerCompanyId) {
      setCredentials([]);
      setLoading(false);
      return;
    }

    setListError("");

    const credentialsQuery = isAdminView
      ? collection(db, "custom_credentials")
      : query(
          collection(db, "custom_credentials"),
          where("companyId", "==", ownerCompanyId),
          where("role", "==", "vendedor")
        );

    const unsub = onSnapshot(credentialsQuery, (snapshot) => {
      const list: UserCredential[] = [];
      snapshot.forEach(docSnap => {
        const data = docSnap.data();
        list.push({
          id: docSnap.id,
          username: data.username || "",
          password: data.password || "",
          displayName: data.displayName || "",
          role: data.role === "user" ? "alimentador" : (data.role || "alimentador"),
          associatedEmail: data.associatedEmail || "",
          companyId: data.companyId || "",
          companyName: data.companyName || "",
          createdAt: data.createdAt
        });
      });
      // Sort by username alphabetically
      list.sort((a, b) => a.username.localeCompare(b.username));
      setCredentials(list);
      setListError("");
      setLoading(false);
    }, (error) => {
      console.error("Error reading custom credentials:", error);
      setListError(
        error?.code === "permission-denied"
          ? "O banco recusou a leitura dos vendedores. Se a empresa da sua credencial mudou há pouco, saia e entre novamente no sistema."
          : "Não foi possível carregar a lista agora. Verifique a conexão e recarregue a página."
      );
      setLoading(false);
    });

    return unsub;
  }, [isAdminView, ownerCompanyId]);

  const handleOpenAdd = () => {
    setIsEditing(false);
    setSelectedId("");
    setUsername("");
    setPassword("");
    setDisplayName("");
    // O dono só cria vendedor, e sempre para a loja dele: os dois campos nascem
    // travados (o formulário nem mostra os seletores).
    setRole(isAdminView ? "alimentador" : "vendedor");
    setAssociatedEmail("");
    setSelectedCompanyId(isAdminView ? "" : ownerCompanyId);
    setFormError("");
    setSuccessMsg("");
    setShowModal(true);
  };

  const handleOpenEdit = (cred: UserCredential) => {
    setIsEditing(true);
    setSelectedId(cred.id);
    setUsername(cred.username);
    setPassword(cred.password);
    setDisplayName(cred.displayName);
    setRole(cred.role);
    setAssociatedEmail(cred.associatedEmail);
    setSelectedCompanyId(cred.companyId || "");
    setFormError("");
    setSuccessMsg("");
    setShowModal(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError("");
    setSuccessMsg("");

    const cleanUsername = username.trim().toLowerCase();
    const cleanPassword = password.trim();
    const cleanDisplayName = displayName.trim();
    const cleanEmail = associatedEmail.trim().toLowerCase();

    if (!cleanUsername || !cleanPassword || !cleanDisplayName) {
      setFormError("Por favor, preencha os campos obrigatórios (Usuário, Senha e Nome).");
      return;
    }

    if (cleanUsername.includes(" ")) {
      setFormError("O nome de usuário não pode conter espaços.");
      return;
    }

    // O dono da empresa não escolhe papel nem empresa: os dois vêm travados aqui,
    // e o Firestore recusa a gravação se chegarem diferentes disso.
    const effectiveRole: UserRole = isAdminView ? role : "vendedor";
    const effectiveCompanyId = isAdminView ? selectedCompanyId : ownerCompanyId;

    if (!isAdminView && !effectiveCompanyId) {
      setFormError(
        "Sua credencial não está vinculada a nenhuma empresa, então não há loja para o vendedor. " +
        "Peça ao administrador para definir a empresa do seu acesso."
      );
      return;
    }

    // Resolve company name to match companyId
    let resolvedCompanyName = "";
    if (effectiveCompanyId) {
      const matchedCompany = companies.find(c => c.id === effectiveCompanyId);
      if (matchedCompany) {
        resolvedCompanyName = matchedCompany.name;
      } else if (!isAdminView) {
        resolvedCompanyName = ownerCompanyName;
      }
    }

    // O admin enxerga a coleção inteira e detecta duplicidade na lista que já tem
    // em mãos. O dono da empresa só enxerga os vendedores DELE — um nome de usuário
    // já usado em outra loja passaria batido, e o login (que busca por usuário)
    // ficaria ambíguo entre as duas credenciais. Por isso aqui a checagem vai ao
    // banco, com o limite pequeno que as regras exigem de quem não é admin.
    const usernameTakenElsewhere = async () => {
      if (isAdminView) return false;
      const snap = await getDocs(
        query(collection(db, "custom_credentials"), where("username", "==", cleanUsername), limit(5))
      );
      return snap.docs.some(d => d.id !== selectedId);
    };

    try {
      if (isEditing) {
        // Prevent editing username to duplicate other credentials
        const dupCheck = credentials.find(c => c.username === cleanUsername && c.id !== selectedId);
        if (dupCheck || (await usernameTakenElsewhere())) {
          setFormError("Este nome de usuário já está sendo utilizado por outra credencial.");
          return;
        }

        const docRef = doc(db, "custom_credentials", selectedId);
        await updateDoc(docRef, {
          username: cleanUsername,
          password: cleanPassword,
          displayName: cleanDisplayName,
          role: effectiveRole,
          associatedEmail: cleanEmail,
          companyId: effectiveCompanyId,
          companyName: resolvedCompanyName,
          updatedAt: serverTimestamp()
        });

        setSuccessMsg("Credencial de segurança atualizada com sucesso!");
        setTimeout(() => setShowModal(false), 800);
      } else {
        // Create verification
        const dupCheck = credentials.find(c => c.username === cleanUsername);
        if (dupCheck || (await usernameTakenElsewhere())) {
          setFormError("Este nome de usuário já está cadastrado.");
          return;
        }

        await addDoc(collection(db, "custom_credentials"), {
          username: cleanUsername,
          password: cleanPassword,
          displayName: cleanDisplayName,
          role: effectiveRole,
          associatedEmail: cleanEmail,
          companyId: effectiveCompanyId,
          companyName: resolvedCompanyName,
          createdAt: serverTimestamp()
        });

        setSuccessMsg(
          isAdminView
            ? "Nova credencial de usuário criada com sucesso!"
            : "Vendedor cadastrado! Passe o usuário e a senha para ele entrar no sistema."
        );
        setTimeout(() => setShowModal(false), 800);
      }
    } catch (err: any) {
      console.error(err);
      setFormError(err.message || "Ocorreu um erro ao salvar a credencial.");
    }
  };

  const handleDelete = async (cred: UserCredential) => {
    if (cred.username === "brisas" || cred.associatedEmail === "brisasofc@gmail.com") {
      alert("Operação proibida! Não é permitido deletar a credencial administrativa nativa master 'brisas'.");
      return;
    }

    // O dono só apaga vendedor da própria loja. A lista dele já vem filtrada
    // assim, mas a checagem fica aqui para o caso de um documento chegar por
    // outro caminho — e o Firestore recusa de qualquer forma.
    if (!isAdminView && (cred.role !== "vendedor" || cred.companyId !== ownerCompanyId)) {
      alert("Você só pode remover os vendedores da sua própria empresa.");
      return;
    }

    if (window.confirm(`Tem certeza que deseja DELETAR permanentemente o acesso do usuário: "${cred.displayName}" (${cred.username})?`)) {
      try {
        await deleteDoc(doc(db, "custom_credentials", cred.id));
      } catch (err) {
        console.error("Error deleting credential", err);
        alert("Erro ao excluir documento de acesso.");
      }
    }
  };

  // Add / Edit Company action
  const handleAddCompanySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setCompFormError("");
    setCompSuccessMsg("");

    const term = newCompanyName.trim();
    const desc = newCompanyDesc.trim();

    if (!term) {
      setCompFormError("Por favor, preencha o nome da empresa.");
      return;
    }

    // Check for duplicates (excluding the current company being edited)
    const checkDup = companies.find(c => c.name.toLowerCase() === term.toLowerCase() && (!isEditingCompany || c.id !== editingCompanyId));
    if (checkDup) {
      setCompFormError("Esta empresa já se encontra cadastrada.");
      return;
    }

    try {
      if (isEditingCompany) {
        // Update company in Firestore
        const compDocRef = doc(db, "companies", editingCompanyId);
        
        // 1. Update company document
        await updateDoc(compDocRef, {
          name: term,
          description: desc,
          updatedAt: serverTimestamp()
        });

        const batch = writeBatch(db);
        let batchCount = 0;

        // 2. Cascade update companyName in credentials linked to this company
        const linkedCredentials = credentials.filter(c => c.companyId === editingCompanyId);
        for (const cred of linkedCredentials) {
          const credDocRef = doc(db, "custom_credentials", cred.id);
          batch.update(credDocRef, {
            companyName: term
          });
          batchCount++;
        }

        // 3. Cascade update companyName in stock items linked to this company
        try {
          const qStock = query(collection(db, "stock"), where("companyId", "==", editingCompanyId));
          const stockSnap = await getDocs(qStock);
          stockSnap.forEach(itemDoc => {
            batch.update(itemDoc.ref, { companyName: term });
            batchCount++;
          });
        } catch (stockErr) {
          console.warn("Could not fetch linked stock items to cascade update:", stockErr);
        }

        if (batchCount > 0) {
          await batch.commit();
        }

        setCompSuccessMsg("Empresa atualizada com sucesso!");
        handleCancelEditCompany();
      } else {
        await addDoc(collection(db, "companies"), {
          name: term,
          description: desc,
          createdAt: serverTimestamp()
        });

        setCompSuccessMsg("Empresa cadastrada com sucesso!");
        setNewCompanyName("");
        setNewCompanyDesc("");
      }

      setTimeout(() => setCompSuccessMsg(""), 3000);
    } catch (err: any) {
      console.error("Error saving company:", err);
      setCompFormError(err.message || "Ocorreu um erro ao salvar a empresa.");
    }
  };

  // Delete Company Action
  const handleDeleteCompany = async (comp: Company) => {
    // Audit if any operator is linked
    const linkedOperatorsCount = credentials.filter(cred => cred.companyId === comp.id).length;
    if (linkedOperatorsCount > 0) {
      alert(`Impossível remover! Existem ${linkedOperatorsCount} operadores vinculados a esta empresa ("${comp.name}"). Remova os operadores ou altere as empresas das credenciais antes de prosseguir.`);
      return;
    }

    if (window.confirm(`Tem certeza que deseja excluir permanentemente esta empresa: "${comp.name}"?`)) {
      try {
        await deleteDoc(doc(db, "companies", comp.id));
      } catch (err) {
        console.error("Failed to delete company:", err);
        alert("Erro ao tentar remover empresa do banco de dados.");
      }
    }
  };

  const filteredCredentials = credentials.filter(c => {
    const search = searchQuery.toLowerCase();
    return (
      c.displayName.toLowerCase().includes(search) ||
      c.username.toLowerCase().includes(search) ||
      c.associatedEmail.toLowerCase().includes(search) ||
      (c.companyName && c.companyName.toLowerCase().includes(search))
    );
  });

  return (
    <div className="bg-white p-6 rounded-2xl border-t-4 border-t-gold-500 border-x border-b border-slate-200/85 shadow-[0_10px_25px_rgba(0,0,0,0.015)] space-y-6 animate-fadeIn font-sans">
      
      {/* Header Panel banner */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 pb-5 border-b border-slate-100">
        <div>
          <h2 className="text-lg font-black text-slate-900 tracking-tight flex items-center gap-2">
            <Users size={20} className="text-gold-600 shrink-0" />
            {isAdminView ? "Gerenciar Configurações Corporativas" : "Meus Vendedores"}
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            {isAdminView ? (
              "Gerencie múltiplos estoques segmentados por empresas, delegando credenciais de acesso operacionais aos seus colaboradores."
            ) : (
              <>
                Cadastre os vendedores de <strong className="text-slate-700">{ownerCompanyName || "sua empresa"}</strong>.
                Eles reservam pneus para clientes — e a reserva <strong className="text-slate-700">prende o pneu na hora</strong>,
                antes de qualquer confirmação. O que depende de você, na aba <strong className="text-slate-700">Reservas</strong>,
                é a baixa: confirmar tira o pneu do estoque e registra a venda.
              </>
            )}
          </p>
        </div>
        
        {subTab === "credentials" && (
          <div className="flex gap-2 flex-wrap">
            {isAdminView && (
              <button
                type="button"
                onClick={handleAutoSeedDefaultData}
                className="flex items-center gap-1.5 px-3.5 py-2.5 bg-slate-900 border border-slate-700 text-gold-400 font-extrabold rounded-xl text-xs cursor-pointer hover:bg-slate-800 transition-all active:scale-[0.98]"
              >
                🚀 Inicializar Padrões
              </button>
            )}
            <button
              type="button"
              onClick={handleOpenAdd}
              disabled={!isAdminView && !ownerCompanyId}
              className="flex items-center gap-1.5 px-4 py-2.5 bg-gradient-to-r from-gold-600 to-amber-550 border border-gold-400/20 text-white font-extrabold rounded-xl text-xs shadow-md shadow-gold-500/10 cursor-pointer transition-all hover:scale-[1.02] active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:scale-100"
            >
              <UserPlus size={14} className="stroke-[2.5px]" /> {isAdminView ? "Criar Credencial" : "Cadastrar Vendedor"}
            </button>
          </div>
        )}
      </div>

      {/* Sub tabs switches — cadastro de empresas e backup são só do admin. */}
      {isAdminView && (
        <div className="flex border-b border-slate-150 pb-px gap-1">
          <button
            type="button"
            onClick={() => setSubTab("credentials")}
            className={`px-4 py-2.5 text-xs font-black rounded-lg transition-all flex items-center gap-1.5 cursor-pointer ${
              subTab === "credentials"
                ? "bg-[#1e1a12] text-gold-400 border border-gold-500/30 font-black shadow-md"
                : "text-slate-500 hover:text-slate-800 hover:bg-slate-100/60"
            }`}
          >
            🔑 Operadores & Credenciais
          </button>
          <button
            type="button"
            onClick={() => setSubTab("companies")}
            className={`px-4 py-2.5 text-xs font-black rounded-lg transition-all flex items-center gap-1.5 cursor-pointer ${
              subTab === "companies"
                ? "bg-[#1e1a12] text-gold-400 border border-gold-500/30 font-black shadow-md"
                : "text-slate-500 hover:text-slate-800 hover:bg-slate-100/60"
            }`}
          >
            🏢 Empresas & Filiais ({companies.length})
          </button>
          <button
            type="button"
            onClick={() => setSubTab("backup")}
            className={`px-4 py-2.5 text-xs font-black rounded-lg transition-all flex items-center gap-1.5 cursor-pointer ${
              subTab === "backup"
                ? "bg-[#1e1a12] text-gold-400 border border-gold-500/30 font-black shadow-md"
                : "text-slate-500 hover:text-slate-800 hover:bg-slate-100/60"
            }`}
          >
            💾 Backup & Restauração
          </button>
        </div>
      )}

      {/* Aviso do dono sem empresa: sem loja não há vendedor para cadastrar. */}
      {!isAdminView && !ownerCompanyId && (
        <div className="bg-amber-50 border-l-4 border-amber-500 text-amber-800 p-3 rounded-xl text-[11px] font-semibold leading-relaxed">
          Seu acesso não está vinculado a nenhuma empresa, então não existe uma loja à qual
          vincular vendedores. Peça ao administrador para definir a sua empresa em
          Operadores e Senhas e entre novamente no sistema.
        </div>
      )}

      {/* RENDER TAB 1: CREDENTIALS */}
      {subTab === "credentials" && (
        <div className="space-y-4 animate-fadeIn">
          {/* Searching filters */}
          <div className="flex gap-2.5 items-center bg-slate-50/50 p-4 rounded-2xl border border-slate-200/80">
            <div className="relative flex-1">
              <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400">
                <Search size={14} className="stroke-[2px] text-gold-600" />
              </div>
              <input
                type="text"
                placeholder={isAdminView
                  ? "Pesquise por nome, usuário, empresa ou e-mail de acesso do Google..."
                  : "Pesquise o vendedor por nome, usuário ou e-mail..."}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9 pr-4 py-2.5 w-full border border-slate-200 bg-white text-slate-900 rounded-xl focus:bg-white focus:ring-4 focus:ring-gold-500/10 focus:border-gold-500 font-semibold text-xs placeholder:text-slate-400 outline-none transition-all"
              />
            </div>
            <div className="text-[10px] text-slate-400 font-extrabold uppercase tracking-widest hidden sm:block whitespace-nowrap">
              {isAdminView ? "Auditados" : "Vendedores"}: <strong className="text-slate-700 text-xs">{filteredCredentials.length}</strong>{" "}
              {isAdminView ? "logins" : "ativos"}
            </div>
          </div>

          {listError && (
            <div className="bg-red-50 border-l-4 border-red-500 text-red-700 p-3 rounded-xl text-[11px] font-semibold leading-relaxed animate-fadeIn">
              {listError}
            </div>
          )}

          {/* Main Credentials Table */}
          {loading ? (
            <div className="flex flex-col items-center justify-center py-12 text-slate-400 gap-2">
              <div className="h-6 w-6 border-2 border-gold-500 border-t-transparent rounded-full animate-spin"></div>
              <p className="text-xs font-bold font-sans">Procurando credenciais no Firebase...</p>
            </div>
          ) : filteredCredentials.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center text-slate-400 bg-slate-50 border border-dashed border-slate-200 rounded-lg">
              <AlertCircle size={44} className="text-slate-300 stroke-[1.5px] mb-2" />
              <p className="font-bold text-slate-700 text-sm">
                {isAdminView ? "Nenhuma credencial encontrada" : "Nenhum vendedor cadastrado"}
              </p>
              <p className="text-[11px] text-slate-400 max-w-sm mt-1">
                {isAdminView
                  ? 'Clique no botão "Criar Credencial" acima para registrar novos operadores ou diretores de estoque.'
                  : 'Clique em "Cadastrar Vendedor" para dar acesso ao primeiro vendedor da sua loja.'}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-2xl border-t-2 border-t-gold-500 border-x border-b border-slate-200/80 shadow-[0_4px_25px_rgba(0,0,0,0.015)] bg-white">
              <table className="min-w-full divide-y divide-slate-150 text-left text-xs table-fixed">
                <thead className="bg-[#fcfbf9] text-slate-400 font-extrabold uppercase tracking-widest text-[10px] border-b border-slate-100/80">
                  <tr>
                    <th className="py-3 px-4 border-b border-slate-100 font-black">Nome de Exibição</th>
                    <th className="py-3 px-4 border-b border-slate-100 w-[110px] font-black">Usuário</th>
                    <th className="py-3 px-4 border-b border-slate-100 w-[110px] font-black">Senha</th>
                    <th className="py-3 px-4 border-b border-slate-100 w-[140px] font-black">Empresa Atribuída</th>
                    <th className="py-3 px-4 border-b border-slate-100 font-black">E-mail do Google (Lock)</th>
                    <th className="py-3 px-4 border-b border-slate-100 w-[100px] text-center font-black">Permissão</th>
                    <th className="py-3 px-4 border-b border-slate-100 w-[100px] text-center font-black">Ações</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 bg-white text-slate-800">
                  {filteredCredentials.map(cred => {
                    const isNativeRoot = cred.username === "brisas";
                    
                    return (
                      <tr key={cred.id} className="hover:bg-gold-50/10 text-slate-850 transition-colors border-b border-slate-100/60">
                        
                        {/* Character Name badge style */}
                        <td className="py-3 px-4 font-bold text-slate-900 truncate">
                          <div className="flex flex-col">
                            <span className="text-xs sm:text-sm font-black text-slate-800">{cred.displayName}</span>
                            {isNativeRoot && (
                              <span className="text-[9px] text-gold-600 block font-extrabold uppercase mt-0.5 tracking-wider">
                                ★ Administrador Master Nativo
                              </span>
                            )}
                          </div>
                        </td>

                        {/* Username login details */}
                        <td className="py-3 px-4 font-mono font-bold text-slate-700">
                          <span className="bg-slate-100 border border-slate-200 rounded-lg px-2 py-0.5 text-[10px] block truncate w-fit font-bold text-slate-700">
                            {cred.username}
                          </span>
                        </td>

                        {/* Password */}
                        <td className="py-3 px-4 font-mono font-bold text-amber-705">
                          <span className="bg-amber-500/5 border border-amber-400/20 rounded-lg px-2 py-0.5 text-[11px] block truncate w-fit font-extrabold text-amber-800 tracking-wider" title="Clique duas vezes para selecionar">
                            {cred.password}
                          </span>
                        </td>

                        {/* Company Assigned details */}
                        <td className="py-3 px-4 text-slate-800 font-bold truncate">
                          {cred.companyName ? (
                            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-xl text-[10px] font-black bg-slate-100 text-slate-700 border border-slate-200 uppercase tracking-wide">
                              <Building size={10} className="text-gold-600" />
                              {cred.companyName}
                            </span>
                          ) : (
                            <span className="text-[9px] font-extrabold text-indigo-700 bg-indigo-50 border border-indigo-150 px-2 py-1 rounded-xl uppercase tracking-widest font-sans inline-block">
                              ★ Todas as Empresas
                            </span>
                          )}
                        </td>

                        {/* Lock Google Email limit check */}
                        <td className="py-3 px-4 text-slate-600 truncate">
                          {cred.associatedEmail ? (
                            <div className="flex items-center gap-1.5">
                              <Check size={12} className="text-emerald-600 shrink-0 stroke-[2.5px]" />
                              <span className="font-semibold text-slate-800 leading-none">{cred.associatedEmail}</span>
                            </div>
                          ) : (
                            <span className="text-slate-350 italic font-semibold flex items-center gap-1">
                              <X size={12} className="text-slate-300 shrink-0 stroke-[2.5px]" /> Qualquer usuário Google
                            </span>
                          )}
                        </td>

                        {/* Security level badges */}
                        <td className="py-3 px-4 text-center">
                          {cred.role === "admin" ? (
                            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[9px] font-extrabold bg-gold-400/10 text-gold-700 border border-gold-300/30 uppercase tracking-widest animate-pulse">
                              <Shield size={9} className="stroke-[2.5px]" /> Admin
                            </span>
                          ) : cred.role === "vendedor" ? (
                            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[9px] font-bold bg-blue-50 text-blue-700 border border-blue-200 uppercase tracking-widest">
                              Vendedor
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[9px] font-bold bg-slate-50 text-slate-600 border border-slate-200 uppercase tracking-widest">
                              Dono da Empresa
                            </span>
                          )}
                        </td>

                        {/* Command buttons */}
                        <td className="py-1 px-4 text-center">
                          <div className="flex items-center justify-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => handleOpenEdit(cred)}
                              className="p-1.5 text-gold-700 hover:bg-gold-50 rounded-lg transition-colors border border-transparent hover:border-gold-200/20 cursor-pointer"
                              title="Editar dados"
                            >
                              <Edit size={12} className="stroke-[2.5px]" />
                            </button>
                            <button
                              type="button"
                              disabled={isNativeRoot}
                              onClick={() => handleDelete(cred)}
                              className={`p-1.5 rounded-lg border transition-all ${
                                isNativeRoot 
                                  ? "text-slate-250 cursor-not-allowed border-transparent" 
                                  : "text-red-500 hover:bg-red-50 hover:border-red-150 border-transparent cursor-pointer"
                              }`}
                              title={isNativeRoot ? "Impossível remover admin nativo" : "Excluir permanentemente"}
                            >
                              <Trash2 size={12} className="stroke-[2.5px]" />
                            </button>
                          </div>
                        </td>

                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* RENDER TAB 2: COMPANIES REGISTER */}
      {isAdminView && subTab === "companies" && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 animate-fadeIn">
          
          {/* Left panel: Add/Edit company form */}
          <div className="lg:col-span-1 bg-[#faf9f6]/80 p-5 rounded-2xl border border-slate-200/80 space-y-4">
            <div>
              <h3 className="text-xs font-black text-slate-9 tracking-widest uppercase flex items-center gap-1">
                <Building size={14} className="text-gold-600" /> {isEditingCompany ? "Editar Empresa" : "Cadastrar Nova Empresa"}
              </h3>
              <p className="text-[10px] text-slate-450 mt-0.5 font-semibold">
                {isEditingCompany ? "Altere os dados cadastrais da empresa selecionada." : "Insira novas subsidiárias, lojas ou depósitos."}
              </p>
            </div>

            {compFormError && (
              <div className="bg-red-50 border-l-4 border-red-500 text-red-700 p-3 rounded-xl text-[11px] font-semibold leading-relaxed animate-fadeIn">
                {compFormError}
              </div>
            )}
            
            {compSuccessMsg && (
              <div className="bg-emerald-50 border-l-4 border-emerald-500 text-emerald-700 p-3 rounded-xl text-[11px] font-semibold flex items-center gap-1.5 animate-fadeIn">
                <Check size={14} className="stroke-[2.5px]" /> {compSuccessMsg}
              </div>
            )}

            <form onSubmit={handleAddCompanySubmit} className="space-y-4">
              <div>
                <label className="block text-[9px] font-black text-slate-550 uppercase tracking-widest mb-1.5">
                  Nome Fantasia da Empresa *
                </label>
                <input
                  type="text"
                  required
                  placeholder="Ex: Pneus Matriz, Filial Norte, Depósito 2"
                  value={newCompanyName}
                  onChange={(e) => setNewCompanyName(e.target.value)}
                  className="w-full px-3 py-2 text-xs text-slate-800 bg-white border border-slate-200 rounded-xl outline-none focus:ring-4 focus:ring-gold-500/10 focus:border-gold-500 transition-all font-semibold"
                />
              </div>

              <div>
                <label className="block text-[9px] font-black text-slate-550 uppercase tracking-widest mb-1.5">
                  Descrição ou Localização (Opcional)
                </label>
                <textarea
                  placeholder="Ex: Av. Principal, 120 - Operacional de Borracharia"
                  rows={3}
                  value={newCompanyDesc}
                  onChange={(e) => setNewCompanyDesc(e.target.value)}
                  className="w-full px-3 py-2 text-xs text-slate-800 bg-white border border-slate-200 rounded-xl outline-none focus:ring-4 focus:ring-gold-500/10 focus:border-gold-500 transition-all resize-none font-semibold leading-relaxed"
                />
              </div>

              <div className="flex flex-col gap-2">
                <button
                  type="submit"
                  className="w-full py-2.5 bg-gradient-to-r from-gold-600 via-gold-500 to-amber-550 text-white font-extrabold rounded-xl text-xs shadow-md shadow-gold-500/10 cursor-pointer transition-all hover:scale-[1.01] active:scale-[0.99] flex items-center justify-center gap-1.5 uppercase tracking-wider"
                >
                  {isEditingCompany ? <Check size={13} className="stroke-[2.5px]" /> : <Plus size={13} className="stroke-[2.5px]" />}
                  {isEditingCompany ? "Salvar Alterações" : "Adicionar Empresa"}
                </button>
                
                {isEditingCompany && (
                  <button
                    type="button"
                    onClick={handleCancelEditCompany}
                    className="w-full py-2 border border-slate-200 text-slate-500 font-extrabold rounded-xl text-xs cursor-pointer hover:bg-slate-50 transition-all text-center uppercase tracking-wider"
                  >
                    Cancelar Edição
                  </button>
                )}
              </div>
            </form>
          </div>

          {/* Right panel: Companies management list table */}
          <div className="lg:col-span-2 space-y-4">
            <div>
              <h3 className="text-xs font-black text-slate-9 tracking-widest uppercase">
                Empresas & Unidades Registradas
              </h3>
              <p className="text-[10px] text-slate-450 mt-0.5 font-semibold">
                Todas as empresas configuradas no banco para o seu estoque unificado.
              </p>
            </div>

            {companies.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center text-slate-400 bg-slate-50 border border-dashed border-slate-200 rounded-xl">
                <Building size={36} className="text-slate-300 mb-2" />
                <p className="font-bold text-slate-700 text-sm">Nenhuma empresa cadastrada</p>
                <p className="text-[11px] text-slate-400 max-w-xs mt-1">
                  Cadastre sua primeira filial ou depósito no formulário ao lado para começar a registrar estoques separados.
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto rounded-2xl border-t-2 border-t-gold-500 border-x border-b border-slate-200/80 shadow-[0_4px_25px_rgba(0,0,0,0.015)] bg-white">
                <table className="min-w-full divide-y divide-slate-150 text-left text-xs table-fixed">
                  <thead className="bg-[#fcfbf9] text-slate-400 font-extrabold uppercase tracking-widest text-[10px] border-b border-slate-100/80">
                    <tr>
                      <th className="py-3 px-4 border-b border-slate-100 font-black">Empresa / Depósito</th>
                      <th className="py-3 px-4 border-b border-slate-100 font-black">Local / Descrição</th>
                      <th className="py-3 px-4 border-b border-slate-100 w-[120px] font-black text-center">Operadores Vinculados</th>
                      <th className="py-3 px-4 border-b border-slate-100 w-[80px] font-black text-center">Ações</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 bg-white text-slate-800">
                    {companies.map(comp => {
                      const linkedOps = credentials.filter(c => c.companyId === comp.id);
                      
                      return (
                        <tr key={comp.id} className="hover:bg-gold-50/10 text-slate-850 transition-colors border-b border-slate-100/60">
                          
                          {/* Name */}
                          <td className="py-3 px-4 font-black text-slate-900 leading-normal">
                            <span className="text-xs sm:text-sm font-black text-slate-850 block">{comp.name}</span>
                            <span className="text-[9px] text-slate-400 block font-semibold leading-normal mt-0.5">ID: {comp.id}</span>
                          </td>

                          {/* Description */}
                          <td className="py-3 px-4 text-slate-500 font-semibold leading-relaxed truncate" title={comp.description}>
                            {comp.description || <span className="text-slate-300 italic">Sem descrição</span>}
                          </td>

                          {/* Linked users count */}
                          <td className="py-3 px-4 text-center">
                            <span className={`inline-flex items-center justify-center h-5 px-2 rounded-full font-black text-[10px] ${
                              linkedOps.length > 0
                                ? "bg-amber-100/40 text-amber-800 border border-amber-200/50"
                                : "bg-slate-100 text-slate-400"
                            }`}>
                              {linkedOps.length} operacional
                            </span>
                          </td>

                          {/* Company actions */}
                          <td className="py-1 px-4 text-center">
                            <div className="flex items-center justify-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => handleOpenEditCompany(comp)}
                                className="p-1.5 rounded-lg border border-transparent hover:bg-gold-50 hover:border-gold-200 text-gold-700 cursor-pointer transition-colors"
                                title="Editar informações da empresa"
                              >
                                <Edit size={12} className="stroke-[2.5px]" />
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDeleteCompany(comp)}
                                className="p-1.5 rounded-lg border border-transparent hover:bg-red-50 hover:border-red-150 text-red-500 cursor-pointer transition-colors"
                                title="Remover empresa dos arquivos"
                              >
                                <Trash2 size={12} className="stroke-[2.5px]" />
                              </button>
                            </div>
                          </td>

                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* RENDER TAB 3: BACKUP & RESTORE */}
      {isAdminView && subTab === "backup" && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 animate-fadeIn text-left">
          
          {/* Export Backup Card */}
          <div className="bg-slate-50/50 p-6 rounded-2xl border border-slate-200/80 space-y-4 flex flex-col justify-between">
            <div className="space-y-2">
              <h3 className="text-sm font-black text-slate-900 uppercase tracking-wider flex items-center gap-1.5">
                💾 Exportar Cópia de Segurança
              </h3>
              <p className="text-xs text-slate-500 font-semibold leading-relaxed">
                Baixe um arquivo contendo todo o banco de dados atual do sistema (incluindo produtos em estoque, filiais, histórico de auditoria e credenciais de operadores).
              </p>
              <div className="bg-blue-50 text-blue-800 p-3 rounded-xl text-[11px] font-semibold leading-relaxed border-l-4 border-blue-500">
                <strong>Recomendação:</strong> Faça o download do backup antes de realizar grandes importações ou alterações em massa no estoque.
              </div>
            </div>
            <button
              onClick={handleExportBackup}
              disabled={exporting}
              className="w-full py-3 bg-gradient-to-r from-gold-600 via-gold-500 to-amber-550 text-white font-extrabold rounded-xl text-xs shadow-md shadow-gold-500/10 cursor-pointer transition-all hover:scale-[1.01] active:scale-[0.99] flex items-center justify-center gap-1.5 uppercase tracking-wider disabled:opacity-50"
            >
              {exporting ? <Loader2 size={13} className="animate-spin" /> : "Baixar Backup (.JSON)"}
            </button>
          </div>

          {/* Import/Restore Backup Card */}
          <div className="bg-red-50/10 p-6 rounded-2xl border border-red-200/30 space-y-4">
            <div className="space-y-2">
              <h3 className="text-sm font-black text-red-600 uppercase tracking-wider flex items-center gap-1.5">
                ⚠️ Restaurar Cópia de Segurança
              </h3>
              <p className="text-xs text-slate-500 font-semibold leading-relaxed">
                Restaure o banco de dados a partir de um arquivo de backup (.json) exportado anteriormente.
              </p>
              <div className="bg-red-50 text-red-700 p-3 rounded-xl text-[11px] font-semibold leading-relaxed border-l-4 border-red-500">
                <strong>CUIDADO:</strong> Esta operação irá <strong>APAGAR permanentemente</strong> todos os dados atuais e substituí-los pelos dados contidos no arquivo de backup.
              </div>
            </div>

            <form onSubmit={handleRestoreBackup} className="space-y-3">
              <div>
                <label className="block text-[9px] font-black text-slate-550 uppercase tracking-widest mb-1">
                  Selecione o Arquivo de Backup (.json)
                </label>
                <input
                  type="file"
                  accept=".json"
                  required
                  onChange={(e) => setBackupFile(e.target.files?.[0] || null)}
                  className="w-full text-xs text-slate-800 bg-white border border-slate-200 rounded-xl p-2 font-semibold outline-none"
                />
              </div>

              <div>
                <label className="block text-[9px] font-black text-slate-550 uppercase tracking-widest mb-1">
                  Confirme digitando a palavra <strong className="text-red-600">RESTAURAR</strong>
                </label>
                <input
                  type="text"
                  required
                  placeholder="Digite RESTAURAR"
                  value={restoreConfirmText}
                  onChange={(e) => setRestoreConfirmText(e.target.value)}
                  className="w-full px-3 py-2 text-xs text-slate-850 bg-white border border-slate-200 rounded-xl outline-none focus:ring-4 focus:ring-red-500/10 focus:border-red-500 transition-all font-bold text-center uppercase"
                />
              </div>

              <button
                type="submit"
                disabled={restoring || !backupFile || restoreConfirmText.toUpperCase() !== "RESTAURAR"}
                className="w-full py-3 bg-gradient-to-r from-red-600 to-red-500 text-white font-extrabold rounded-xl text-xs shadow-md shadow-red-500/10 cursor-pointer transition-all hover:scale-[1.01] active:scale-[0.99] flex items-center justify-center gap-1.5 uppercase tracking-wider disabled:opacity-50"
              >
                {restoring ? <Loader2 size={13} className="animate-spin" /> : "Iniciar Restauração de Dados"}
              </button>
            </form>
          </div>

          {/* Wipe System Card */}
          <div className="bg-white border border-red-200 rounded-3xl p-5 shadow-sm mt-6">
            <div className="flex flex-col mb-4">
              <h3 className="text-xs font-black text-slate-850 uppercase tracking-widest flex items-center gap-1.5 mb-1">
                <AlertTriangle size={15} className="text-red-500" />
                Zerar Sistema (Produção)
              </h3>
              <p className="text-[11px] text-slate-500 font-semibold leading-relaxed">
                Apaga todas as movimentações, transferências e itens em estoque.
                Usuários, credenciais e empresas serão mantidos.
              </p>
            </div>

            <form onSubmit={handleWipeSystem} className="space-y-3">
              <div>
                <label className="block text-[9px] font-black text-slate-550 uppercase tracking-widest mb-1">
                  Confirme digitando a palavra <strong className="text-red-600">PRODUCAO</strong>
                </label>
                <input
                  type="text"
                  required
                  placeholder="Digite PRODUCAO"
                  value={wipeConfirmText}
                  onChange={(e) => setWipeConfirmText(e.target.value)}
                  className="w-full px-3 py-2 text-xs text-slate-850 bg-white border border-red-200 rounded-xl outline-none focus:ring-4 focus:ring-red-500/10 focus:border-red-500 transition-all font-bold text-center uppercase"
                />
              </div>

              <button
                type="submit"
                disabled={wiping || wipeConfirmText.toUpperCase() !== "PRODUCAO"}
                className="w-full py-3 bg-slate-900 text-white font-extrabold rounded-xl text-xs shadow-md cursor-pointer transition-all hover:bg-slate-800 flex items-center justify-center gap-1.5 uppercase tracking-wider disabled:opacity-50"
              >
                {wiping ? <Loader2 size={13} className="animate-spin" /> : "Apagar Todos os Registros (Estoque)"}
              </button>
            </form>
          </div>

        </div>
      )}

      {/* ================= MODAL DIALOG: ADD/EDIT DIALOG ================= */}
      {showModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-3xs flex items-center justify-center z-50 p-4 transition-all duration-200 animate-fadeIn">
          <div className="bg-white rounded-2xl border-t-4 border-t-gold-500 border-x border-b border-slate-200 shadow-2xl max-w-md w-full overflow-hidden p-6 relative flex flex-col gap-4 animate-scaleUp">
            
            <button
              onClick={() => setShowModal(false)}
              className="absolute top-4 right-4 text-slate-400 hover:text-slate-600 p-1.5 rounded-full hover:bg-slate-100 cursor-pointer transition-all"
              title="Fechar"
            >
              <X size={18} />
            </button>

            {/* Title with corresponding icons */}
            <div>
              <h3 className="text-base font-black text-slate-900 tracking-tight flex items-center gap-1.5 font-sans">
                {isEditing ? <Edit size={16} className="text-gold-600" /> : <UserPlus size={16} className="text-gold-600" />}
                {isAdminView
                  ? (isEditing ? "Alterar Credencial Operacional" : "Nova Credencial de Segurança")
                  : (isEditing ? "Alterar Acesso do Vendedor" : "Cadastrar Vendedor")}
              </h3>
              <p className="text-[11px] text-slate-400 leading-normal font-semibold font-sans">
                {isAdminView
                  ? "Determine as chaves para esse colaborador operar o Central Stoque."
                  : `Este acesso fica vinculado a ${ownerCompanyName || "sua empresa"} e só permite reservar pneus para clientes.`}
              </p>
            </div>

            {/* Error notifications */}
            {formError && (
              <div className="bg-red-50 border-l-4 border-red-500 text-red-700 p-3 rounded-xl text-[11px] font-semibold leading-relaxed animate-fadeIn">
                {formError}
              </div>
            )}
            {successMsg && (
              <div className="bg-emerald-50 border-l-4 border-emerald-500 text-emerald-700 p-3 rounded-xl text-[11px] font-semibold flex items-center gap-1.5 animate-fadeIn">
                <Check size={14} className="stroke-[2.5px]" /> {successMsg}
              </div>
            )}

            <form onSubmit={handleSave} className="space-y-4 font-sans text-left">
              
              {/* Field 1: Display name */}
              <div>
                <label className="block text-[10px] font-black text-slate-550 uppercase tracking-widest mb-1.5">
                  Nome do Operador ou Loja *
                </label>
                <input
                  type="text"
                  required
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  className="w-full px-3 py-2 text-xs text-slate-800 bg-white border border-slate-200 rounded-xl outline-none focus:ring-4 focus:ring-gold-500/10 focus:border-gold-500 transition-all font-semibold"
                  placeholder="Ex: João da Borracharia, Operador Matriz"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                
                {/* Field 2: Username login identifier */}
                <div>
                  <label className="block text-[10px] font-black text-slate-550 uppercase tracking-widest mb-1.5 flex items-center gap-0.5">
                    Nome de Usuário * <span className="text-[8px] text-slate-400 lowercase">(sem espaços)</span>
                  </label>
                  <input
                    type="text"
                    required
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    className="w-full px-3 py-2 text-xs text-slate-850 font-mono font-extrabold bg-slate-50 border border-slate-250 rounded-xl outline-none focus:ring-4 focus:ring-gold-500/10 focus:border-gold-500 uppercase transition-all"
                    placeholder="ex: borracharia2"
                    disabled={isEditing} // Username cannot be changed after creation
                  />
                </div>

                {/* Field 3: Password access code */}
                <div>
                  <label className="block text-[10px] font-black text-slate-550 uppercase tracking-widest mb-1.5 font-bold">
                    Senha Secreta *
                  </label>
                  <input
                    type="text"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full px-3 py-2 text-xs text-amber-800 font-mono font-extrabold bg-white border border-slate-200 rounded-xl outline-none focus:ring-4 focus:ring-gold-500/10 focus:border-gold-500 transition-all"
                    placeholder="Ex: @#central@#"
                  />
                </div>

              </div>

              {/* Field 4: Associated Google verification restrict locks (Optional) */}
              <div>
                <label className="block text-[10px] font-black text-slate-550 uppercase tracking-widest mb-1.5 flex items-center gap-1">
                  E-mail Google Vinculado <span className="text-[8.5px] text-slate-450 normal-case font-semibold">(Opcional para extra segurança)</span>
                </label>
                <input
                  type="email"
                  value={associatedEmail}
                  onChange={(e) => setAssociatedEmail(e.target.value)}
                  className="w-full px-3 py-2 text-xs text-slate-800 bg-white border border-slate-200 rounded-xl outline-none focus:ring-4 focus:ring-gold-500/10 focus:border-gold-500 font-semibold transition-all"
                  placeholder="Ex: operador@gmail.com"
                />
                <span className="text-[9px] text-slate-400 block mt-1.5 font-medium leading-relaxed">
                  Se preenchido, o operador é obrigado a estar autenticado no Google com esse mesmo e-mail exato para liberar a senha secundária.
                </span>
              </div>

              {/* Field 5: Associated Company selection — travada para o dono da empresa */}
              {!isAdminView ? (
                <div>
                  <label className="block text-[10px] font-black text-slate-550 uppercase tracking-widest mb-1.5 flex items-center gap-1">
                    Empresa Vinculada ao Vendedor
                  </label>
                  <div className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-xl font-black text-slate-700 flex items-center gap-1.5">
                    <Building size={12} className="text-gold-600 shrink-0" />
                    {ownerCompanyName || "Sua empresa"}
                  </div>
                  <span className="text-[9px] text-slate-400 block mt-1.5 font-medium leading-relaxed">
                    O vendedor nasce vinculado à sua loja. No catálogo, os pneus dela aparecem como
                    reserva da casa; os das outras filiais viram solicitação para aquela filial decidir.
                    Nos dois casos o pneu só fica preso depois que o dono confirma.
                  </span>
                </div>
              ) : (
              <div>
                <label className="block text-[10px] font-black text-slate-550 uppercase tracking-widest mb-1.5 flex items-center gap-1">
                  Empresa Vinculada ao Operador
                </label>
                <select
                  value={selectedCompanyId}
                  onChange={(e) => setSelectedCompanyId(e.target.value)}
                  className="w-full px-3 py-2 text-xs text-slate-800 bg-white border border-slate-200 rounded-xl outline-none focus:ring-4 focus:ring-gold-500/10 focus:border-gold-500 transition-all font-semibold"
                >
                  <option value="">Todas as Empresas (Privilégio de Visualizar Tudo)</option>
                  {companies.map(comp => (
                    <option key={comp.id} value={comp.id}>
                      {comp.name}
                    </option>
                  ))}
                </select>
                <span className="text-[9px] text-slate-400 block mt-1.5 font-medium leading-relaxed">
                  Selecione a empresa à qual este operador pertence. Ele só poderá visualizar e lançar produtos para este estoque. Deixe em branco se desejar dar acesso a todas as empresas.
                </span>
              </div>
              )}

              {/* Field 6: System Access Role level selection slider */}
              {isAdminView && (
              <div className="bg-slate-50 p-3 rounded-xl border border-slate-100">
                <span className="block text-[9px] font-extrabold text-slate-555 uppercase tracking-widest mb-2 flex items-center gap-1">
                  <ShieldCheck size={12} className="text-gold-600" /> Nível de Acesso no Central Stoque
                </span>
                <div className="grid grid-cols-3 gap-2">
                  <button
                    type="button"
                    onClick={() => setRole("alimentador")}
                    className={`py-2 px-2 text-[10px] font-black rounded-lg border uppercase tracking-wider transition-all cursor-pointer ${
                      (role === "alimentador" || role === "user")
                        ? "bg-slate-800 text-white border-slate-800 shadow-xs"
                        : "bg-white text-slate-600 border-slate-200 hover:bg-slate-100"
                    }`}
                  >
                    Dono da Empresa
                  </button>
                  <button
                    type="button"
                    onClick={() => setRole("vendedor")}
                    className={`py-2 px-2 text-[10px] font-black rounded-lg border uppercase tracking-wider transition-all cursor-pointer ${
                      role === "vendedor"
                        ? "bg-blue-800 text-white border-blue-800 shadow-xs"
                        : "bg-white text-slate-600 border-slate-200 hover:bg-slate-100"
                    }`}
                  >
                    Vendedor
                  </button>
                  <button
                    type="button"
                    onClick={() => setRole("admin")}
                    className={`py-2 px-2 text-[10px] font-black rounded-lg border uppercase tracking-wider transition-all cursor-pointer ${
                      role === "admin"
                        ? "bg-gradient-to-r from-gold-600 to-amber-550 border-transparent text-white shadow-xs"
                        : "bg-white text-slate-600 border-slate-200 hover:bg-slate-100"
                    }`}
                  >
                    Administrador Pleno
                  </button>
                </div>
              </div>
              )}

              {/* Submit Buttons */}
              <div className="flex justify-end gap-2 pt-3 border-t border-slate-100 text-right">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="px-4 py-2 border border-slate-250 hover:bg-slate-50 text-slate-600 font-bold rounded-xl text-xs cursor-pointer transition-all uppercase tracking-wider"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-gradient-to-r from-emerald-600 to-emerald-500 hover:from-emerald-700 hover:to-emerald-600 text-white font-extrabold rounded-xl text-xs shadow-md shadow-emerald-550/10 cursor-pointer transition-all uppercase tracking-wider"
                >
                  Salvar Mudanças
                </button>
              </div>

            </form>
            
          </div>
        </div>
      )}

    </div>
  );
}
