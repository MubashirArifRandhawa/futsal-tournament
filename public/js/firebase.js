// Firebase is loaded straight from Google's CDN, so the site needs no build step.
// Firestore uses its default in-memory cache: nothing is written to localStorage.
import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-app.js';
import {
  getFirestore,
  doc,
  collection,
  onSnapshot,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  writeBatch,
  runTransaction,
} from 'https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js';

export const configured = Boolean(firebaseConfig.apiKey) && !String(firebaseConfig.apiKey).startsWith('YOUR_');

export const app = configured ? initializeApp(firebaseConfig) : null;
export const db = configured ? getFirestore(app) : null;

export { doc, collection, onSnapshot, getDoc, getDocs, setDoc, updateDoc, deleteDoc, writeBatch, runTransaction };
