'use client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';

let queryClient: QueryClient | undefined;

function getQueryClient() {
  if (!queryClient) {
    queryClient = new QueryClient();
  }
  return queryClient;
}

export const AppQueryProvider: React.FC<React.PropsWithChildren> = ({ children }) => {
  const client = getQueryClient();
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
};
