import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import ProductApp from './ProductApp'
import './product.css'

const root = document.getElementById('product-root')
if (!root) throw new Error('Product root is missing')
createRoot(root).render(<StrictMode><ProductApp /></StrictMode>)
