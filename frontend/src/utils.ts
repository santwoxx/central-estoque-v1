export function formatBRL(value: number): string {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(value);
}

export function formatDate(timestamp: any): string {
  if (!timestamp) return "N/D";
  
  // Handle Firestore Timestamp or standard Dates
  let date: Date;
  if (timestamp.toDate && typeof timestamp.toDate === "function") {
    date = timestamp.toDate();
  } else if (timestamp instanceof Date) {
    date = timestamp;
  } else if (typeof timestamp === "string" || typeof timestamp === "number") {
    date = new Date(timestamp);
  } else if (timestamp.seconds) {
    date = new Date(timestamp.seconds * 1000);
  } else {
    return "N/D";
  }

  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

export function exportToCSV(data: any[], columns: { key: string; label: string }[], filename: string) {
  // Build header row
  const headers = columns.map(col => `"${col.label.replace(/"/g, '""')}"`).join(";");
  
  // Build data rows
  const rows = data.map(item => {
    return columns.map(col => {
      let val = item[col.key];
      if (val === undefined || val === null) {
        val = "";
      } else if (typeof val === "object") {
        // If it's a date or timestamp
        if (val.toDate) {
          val = formatDate(val);
        } else {
          val = JSON.stringify(val);
        }
      }
      // Format quantities / numbers if needed, or escape strings
      const stringVal = String(val).replace(/"/g, '""');
      return `"${stringVal}"`;
    }).join(";");
  });

  const csvContent = "\uFEFF" + [headers, ...rows].join("\n"); // Include BOM for proper Excel encoding
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  
  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.setAttribute("download", `${filename}.csv`);
  link.style.visibility = "hidden";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}
