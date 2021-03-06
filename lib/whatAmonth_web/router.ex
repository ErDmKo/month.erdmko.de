defmodule WhatAmonthWeb.Router do
  use WhatAmonthWeb, :router

  pipeline :browser do
    plug :accepts, ["html"]
    plug :fetch_session
    plug :fetch_flash
    plug :protect_from_forgery
    plug :put_secure_browser_headers
  end

  pipeline :api do
    plug :accepts, ["json"]
  end

  scope "/", WhatAmonthWeb do
    pipe_through :browser

    get "/", MainPageController, :index
  end

  scope "/month", WhatAmonthWeb do
    pipe_through :browser

    get "/", MonthPageController, :index
    get "/:id", MonthPageController, :month
  end

  # Other scopes may use custom stacks.
  # scope "/api", WhatAmonthWeb do
  #   pipe_through :api
  # end
end
