defmodule WhatAmonthWeb.LayoutView do
  use WhatAmonthWeb, :view
  require Logger

  def description(%{:isIndex => true}) do
    ~s/Номера месяцев в году/
  end

  def description(%{:month => month}) do
    ~s/Номер месяца #{getTitle(month)} в году/
  end

  def description(_a) do
    "Номера месяцев в году"
  end

  def title(%{:isIndex => true}) do
    ~s/Какой месяц сейчас?/
  end

  def title(%{:month => month}) do
    ~s/Какой номер месяца y #{getTitle(month)}?/
  end

  def title(_a) do
    "Какой номер у месяца"
  end
end
