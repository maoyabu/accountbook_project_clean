// public/js/uiHandlers.js

(function () {
  const largeCf = document.getElementById("cf");
  const expenseGroup = document.getElementById("expense_group");
  const incomeGroup = document.getElementById("income_group");
  const deductionGroup = document.getElementById("deduction_group");
  const savingGroup = document.getElementById("saving_group");

  function updateCategories() {
    console.log("updateCategories 実行: ", largeCf?.value);
    if (!largeCf || !incomeGroup || !expenseGroup || !deductionGroup || !savingGroup) return;

    expenseGroup.style.display = "none";
    incomeGroup.style.display = "none";
    deductionGroup.style.display = "none";
    savingGroup.style.display = "none";

    switch (largeCf.value) {
      case "支出":
        expenseGroup.style.display = "block";
        break;
      case "収入":
        incomeGroup.style.display = "block";
        break;
      case "控除":
        deductionGroup.style.display = "block";
        break;
      case "貯蓄":
        savingGroup.style.display = "block";
        break;
    }
  }

  if (largeCf) {
    largeCf.addEventListener("change", updateCategories);
    window.updateCategories = updateCategories;
    updateCategories();
  }
})();